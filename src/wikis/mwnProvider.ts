import { Mwn, type MwnOptions } from 'mwn';
import { readSessionFile } from '../bwiki/cookie.ts';
import { RequestThrottle } from '../bwiki/throttle.ts';
import type { ExecSecret, WikiConfig } from '../config/loadConfig.ts';
import { DEFAULT_SESSION_FILE } from '../config/loadConfig.ts';
import { callDeadline, WIKI_CONNECT_TIMEOUT_MS } from '../runtime/callDeadline.ts';
import { USER_AGENT, refererFor } from '../runtime/constants.ts';
import { logger } from '../runtime/logger.ts';
import { getRequestSignal } from '../runtime/requestContext.ts';
import { withCallBounds } from './abortableMwn.ts';
import type { ActiveWiki } from './activeWiki.ts';
import { runExecSecret } from './execSecret.ts';
import { redactAuthorizationHeader, wrapMwnErrors } from './mwnErrorSanitizer.ts';
import type { WikiRegistry } from './wikiRegistry.ts';

interface MwnProvider {
    get(wikiKey?: string): Promise<Mwn>;
    invalidate(wikiKey: string): void;
    /** 丢弃已缓存的 passport 会话与 mwn 实例，供登录成功后重新读取。 */
    invalidatePassportSession(): void;
}

class MwnProviderImpl implements MwnProvider {
    // 缓存 Promise，使并发的首次调用共享一次连接。
    private readonly cache = new Map<string, Promise<Mwn>>();

    // exec 凭证缓存；失败即驱逐以便重试。
    private readonly secretCache = new Map<string, Promise<string | null>>();

    // 全进程一个节流：限流按连接计，不按 wiki 区分。
    private readonly throttle = new RequestThrottle();

    // 按会话文件缓存 passport cookie。
    private readonly passportSessionCache = new Map<string, Promise<string | null>>();

    public constructor(
        private readonly wikis: WikiRegistry,
        private readonly activeWiki: ActiveWiki,
        private readonly getRuntimeToken: () => string | undefined,
    ) {}

    public async get(wikiKey?: string): Promise<Mwn> {
        let key: string;
        let config: Readonly<WikiConfig> | undefined;
        if (wikiKey !== undefined) {
            key = wikiKey;
            config = this.wikis.get(wikiKey);
            if (!config) {
                throw new Error(`Wiki "${wikiKey}" not found`);
            }
        } else {
            ({ key, config } = this.activeWiki.get());
        }
        return this.getInstance(key, config);
    }

    private async getInstance(key: string, config: Readonly<WikiConfig>): Promise<Mwn> {
        const runtimeToken = this.getRuntimeToken();
        if (runtimeToken) {
            return this.create(key, config, runtimeToken);
        }

        let pending = this.cache.get(key);
        if (!pending) {
            pending = this.create(key, config);
            this.cache.set(key, pending);
            // 失败时移出缓存以便重试。
            pending.catch(() => {
                this.cache.delete(key);
            });
        }
        return pending;
    }

    public invalidate(key: string): void {
        // 只丢弃 mwn 实例，凭证缓存保留。
        this.cache.delete(key);
    }

    private async resolveSecret(
        wikiKey: string,
        field: 'token' | 'username' | 'password',
        raw: string | ExecSecret | null | undefined,
    ): Promise<string | null> {
        if (raw === null || raw === undefined) {
            return null;
        }
        if (typeof raw === 'string') {
            return raw;
        }
        const cacheKey = `${wikiKey} ${field}`;
        let pending = this.secretCache.get(cacheKey);
        if (!pending) {
            pending = runExecSecret(raw, `the "${field}" credential for wiki "${wikiKey}"`);
            this.secretCache.set(cacheKey, pending);
            // 失败即驱逐以免永久缓存瞬时故障。
            pending.catch(() => {
                this.secretCache.delete(cacheKey);
            });
        }
        return pending;
    }

    private async create(
        key: string,
        config: Readonly<WikiConfig>,
        runtimeToken?: string,
    ): Promise<Mwn> {
        const { server, scriptpath } = config;
        const apiUrl = `${server}${scriptpath}/api.php`;

        // BWiki 账号即 bilibili 身份，凭证为已存 passport cookie。
        // 若设置了 runtime token 或用户名密码，则优先使用。
        const token = runtimeToken
            ? undefined
            : await this.resolveSecret(key, 'token', config.token);
        const effectiveToken: string | undefined = runtimeToken ?? token ?? undefined;

        // 仅在未配置其他凭证时才查 passport 会话。
        const passportSession =
            effectiveToken || (await this.hasAnySecret(config, ['username', 'password']))
                ? undefined
                : await this.resolvePassportSession(config);

        let username: string | null = null;
        let password: string | null = null;
        if (!effectiveToken && !passportSession) {
            username = await this.resolveSecret(key, 'username', config.username);
            password = await this.resolveSecret(key, 'password', config.password);
        }

        const options: MwnOptions = {
            apiUrl,
            userAgent: USER_AGENT,
        };
        if (effectiveToken) {
            options.OAuth2AccessToken = effectiveToken;
        } else if (username && password) {
            options.username = username;
            options.password = password;
            // 强制 assert=user：会话过期时返回 assertuserfailed 而非静默降级，
            // mwn 会据此自动重新登录并重试。
            options.defaultParams = { ...options.defaultParams, assert: 'user' };
        }

        const instance = new Mwn(options);
        if (passportSession) {
            await injectPassportCookie(instance, passportSession, apiUrl);
        }
        applyReferer(instance, apiUrl);
        try {
            // 不用 Mwn.init：它无法限制三次往返的重试预算。
            const connecting = withCallBounds(
                instance,
                callDeadline(WIKI_CONNECT_TIMEOUT_MS, 'connecting'),
            );
            if (effectiveToken) {
                // 不发请求，无需经过包装视图。
                instance.initOAuth();
                await connecting.getTokensAndSiteInfo();
            } else if (username && password) {
                await connecting.login();
            } else {
                await connecting.getSiteInfo();
            }
        } catch (error: unknown) {
            redactAuthorizationHeader(error, effectiveToken);
            throw error;
        }

        // 节流包装在实例外层，连接期的往返同样受限速约束。
        return wrapMwnErrors(pacedMwn(instance, this.throttle), effectiveToken);
    }

    /**
     * 仅看配置形状，不执行 exec 来源的密钥。
     */
    private async hasAnySecret(
        config: Readonly<WikiConfig>,
        fields: readonly string[],
    ): Promise<boolean> {
        for (const field of fields) {
            const value = (config as unknown as Record<string, unknown>)[field];
            if (value !== null && value !== undefined && value !== '') {
                return true;
            }
        }
        return false;
    }

    /**
     * 读取已存会话，无则返回 null。按文件路径缓存。
     *
     * 返回 null 而非抛出：无会话是待登录状态，由调用方决定是触发登录还是报错。
     * 只缓存成功读到的会话：null 与异常都不入缓存，否则登录成功后仍会读到旧结论。
     */
    private async resolvePassportSession(config: Readonly<WikiConfig>): Promise<string | null> {
        const file = config.passportSessionFile || DEFAULT_SESSION_FILE;
        const cached = this.passportSessionCache.get(file);
        if (cached) {
            return cached;
        }
        const pending = readPassportSessionFromDisk(file).catch(() => null);
        this.passportSessionCache.set(file, pending);
        const session = await pending;
        if (session === null && this.passportSessionCache.get(file) === pending) {
            this.passportSessionCache.delete(file);
        }
        return session;
    }

    /** 丢弃已缓存的 passport 会话与 mwn 实例，供登录成功后重新读取。 */
    public invalidatePassportSession(): void {
        this.passportSessionCache.clear();
        // 旧实例里注入的是失效凭证，必须丢弃。
        this.cache.clear();
    }
}

/**
 * 注入 passport cookie。api.php 直接接受 SESSDATA，无需先换 wiki 会话。
 * 不写 Domain 属性，使 cookie 为 host-only。
 *
 * 逐条 await：首请求发出前 cookie 必须已经在 jar 里。单条格式错误只告警，
 * 不影响其余 cookie（例如缺 bili_jct 仍可读，影响面由首次请求暴露）。
 */
const injectPassportCookie = async (
    instance: Mwn,
    cookie: string,
    apiUrl: string,
): Promise<void> => {
    for (const pair of cookie
        .split(';')
        .map(c => c.trim())
        .filter(Boolean)) {
        const eq = pair.indexOf('=');
        const name = eq > 0 ? pair.slice(0, eq) : '';
        const value = eq > 0 ? pair.slice(eq + 1) : '';
        if (!name || !value) {
            continue;
        }
        try {
            await instance.cookieJar.setCookie(`${name}=${value}; Path=/`, apiUrl);
        } catch (err) {
            // 只记名字，值属于凭证，不落日志。
            logger.warning(
                `mwn: could not set cookie "${name}" for ${apiUrl}: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
        }
    }
};

/**
 * 为实例的所有请求设置 Referer，指向站点自身。
 *
 * 用 `axiosInstance.defaults` 而非 `setRequestOptions`：mwn 的后者只写不读。
 * 该属性按实例隔离，多个 wiki 互不覆盖。
 */
const applyReferer = (instance: Mwn, apiUrl: string): void => {
    const referer = refererFor(apiUrl);
    if (referer === undefined) {
        return;
    }
    // 就地赋值：axios 的 headers 类型不接受展开构造的对象。
    instance.axiosInstance.defaults.headers.common.Referer = referer;
};

/**
 * 用进程级节流包装实例的全部请求（含登录、siteinfo、CSRF、重试）。
 * 567/514 不触发 mwn 重试，在此记录冷却。
 */
const pacedMwn = (instance: Mwn, throttle: RequestThrottle): Mwn => {
    const original = instance.request.bind(instance);
    instance.request = async (params, customRequestOptions) =>
        // 传入调用方的取消信号：冷却/间隔等待可随调用取消而中断。
        // 发送时刻由 throttle.run 记录，此处不再 noteSent。
        throttle.run(async () => {
            try {
                return await original(params, customRequestOptions);
            } catch (error: unknown) {
                throttle.reportBlock(statusOf(error));
                throw error;
            }
        }, getRequestSignal());
    return instance;
};

/**
 * 取 axios 异常上的 HTTP 状态码。
 * errno 型异常的 `code` 是 'ECONNRESET' 之类的系统调用名，不是状态码。
 */
const statusOf = (error: unknown): number | undefined => {
    if (typeof error !== 'object' || error === null) {
        return undefined;
    }
    const status = (error as { response?: { status?: unknown } }).response?.status;
    return typeof status === 'number' ? status : undefined;
};

/**
 * 从会话文件读取 passport cookie。优先用 wiki cookie，其次用 passport cookie，
 * 两者均可通过认证。
 */
const readPassportSessionFromDisk = async (file: string): Promise<string> => {
    const session = await readSessionFile(file);
    if (!session) {
        throw new Error(`未登录：${file} 中没有会话。请先调用 bwiki-login 完成 bilibili 登录。`);
    }
    const cookie = session.wikiCookie || session.passportCookie;
    if (!cookie) {
        throw new Error(`${file} 中的登录态缺少 cookie，请重新调用 bwiki-login 登录。`);
    }
    return cookie;
};

export { MwnProviderImpl, injectPassportCookie };
export type { MwnProvider };
