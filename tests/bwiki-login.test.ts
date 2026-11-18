/**
 * bwiki-login 工具的单元测试。
 *
 * 浏览器与身份校验都 mock：只验证工具的接线——从 ctx 取站点与会话路径、
 * 写入会话、通知登录门、无人值守环境下拒绝开浏览器、与登录门共享互斥。
 */

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loginMutex } from '../src/bwiki/loginGate.ts';
import { loginViaOfficialPage } from '../src/bwiki/passportLogin.ts';
import type { WikiConfig } from '../src/config/loadConfig.ts';
import { ResponseFormatterImpl } from '../src/results/response.ts';
import type { ToolContext } from '../src/runtime/context.ts';
import { logger } from '../src/runtime/logger.ts';
import { bwikiLogin } from '../src/tools/bwiki-login.ts';
import { ActiveWikiImpl } from '../src/wikis/activeWiki.ts';
import { WikiRegistryImpl } from '../src/wikis/wikiRegistry.ts';

const { FakeIdentity, identityState } = vi.hoisted(() => {
    const state = {
        apiUrls: [] as string[],
        cookies: [] as string[],
        name: '100000000',
        canEdit: true,
        failure: null as Error | null,
    };

    class FakeIdentity {
        public constructor(apiUrl: string) {
            state.apiUrls.push(apiUrl);
        }

        public async establish(
            cookie: string,
        ): Promise<{ name: string; canEdit: boolean; wikiCookie: string }> {
            state.cookies.push(cookie);
            if (state.failure) {
                throw state.failure;
            }
            return { name: state.name, canEdit: state.canEdit, wikiCookie: 'gamecenter_wiki=w' };
        }
    }

    return { FakeIdentity, identityState: state };
});

vi.mock('../src/bwiki/identity.ts', () => ({
    Identity: FakeIdentity,
    NotLoggedInError: class NotLoggedInError extends Error {},
}));

vi.mock('../src/bwiki/passportLogin.ts', () => ({ loginViaOfficialPage: vi.fn() }));

const loginMock = vi.mocked(loginViaOfficialPage);

let dir: string;
let sessionFile: string;

const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(res => {
        resolve = res;
    });
    return { promise, resolve };
};

const wikiConfig = (key: string, session: string): WikiConfig => ({
    sitename: '',
    server: `https://example.invalid/${key}`,
    articlepath: `/${key}`,
    scriptpath: '',
    passportSessionFile: session,
});

/** 组装最小 ToolContext：只提供工具实际读取的字段。 */
const makeCtx = (
    registry: WikiRegistryImpl,
    defaultKey: string,
    markAuthenticated: ReturnType<typeof vi.fn>,
): ToolContext =>
    ({
        wikis: registry,
        activeWiki: new ActiveWikiImpl(defaultKey, registry),
        loginGate: { markAuthenticated },
        logger,
        format: new ResponseFormatterImpl(),
    }) as unknown as ToolContext;

const envelopeOf = (result: {
    content: Array<{ type: string; text?: string }>;
}): Record<string, unknown> =>
    JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bwiki-login-tool-'));
    sessionFile = join(dir, 'session.json');
    identityState.apiUrls.length = 0;
    identityState.cookies.length = 0;
    identityState.name = '100000000';
    identityState.canEdit = true;
    identityState.failure = null;
    loginMock.mockReset();
    await vi.waitFor(() => expect(loginMutex.isBusy()).toBe(false));
});

afterEach(async () => {
    vi.unstubAllEnvs();
    await vi.waitFor(() => expect(loginMutex.isBusy()).toBe(false));
    await rm(dir, { recursive: true, force: true });
});

describe('bwiki-login', () => {
    it('登录成功后写入会话并通知登录门', async () => {
        loginMock.mockResolvedValue({ cookie: 'SESSDATA=abc; bili_jct=t', userId: '100000000' });
        const registry = new WikiRegistryImpl(
            {
                other: wikiConfig('other', join(dir, 'other.json')),
                ci: wikiConfig('ci', sessionFile),
            },
            false,
        );
        const markAuthenticated = vi.fn();
        const ctx = makeCtx(registry, 'ci', markAuthenticated);

        const result = await bwikiLogin.handle({}, ctx);

        expect(result.isError).not.toBe(true);
        const payload = result.structuredContent as {
            userId: string;
            canEdit: boolean;
            sessionFile: string;
        };
        expect(payload.userId).toBe('100000000');
        expect(payload.canEdit).toBe(true);
        expect(payload.sessionFile).toBe(sessionFile);

        // 默认站点的 api.php，而不是请求上下文里的站点。
        expect(identityState.apiUrls).toEqual(['https://example.invalid/ci/api.php']);
        expect(identityState.cookies).toEqual(['SESSDATA=abc; bili_jct=t']);

        expect(JSON.parse(await readFile(sessionFile, 'utf8'))).toEqual({
            passportCookie: 'SESSDATA=abc; bili_jct=t',
            wikiCookie: 'gamecenter_wiki=w',
            userId: '100000000',
            savedAt: expect.any(Number),
        });
        expect(markAuthenticated).toHaveBeenCalledWith('100000000');
    });

    it('BWIKI_MCP_NO_BROWSER_LOGIN=1 时返回认证错误且不开浏览器', async () => {
        vi.stubEnv('BWIKI_MCP_NO_BROWSER_LOGIN', '1');
        const registry = new WikiRegistryImpl({ ci: wikiConfig('ci', sessionFile) }, false);
        const ctx = makeCtx(registry, 'ci', vi.fn());

        const result = await bwikiLogin.handle({}, ctx);

        expect(result.isError).toBe(true);
        const envelope = envelopeOf(result);
        expect(envelope.category).toBe('authentication');
        expect(String(envelope.message)).toContain('bwiki-mcp-server login');
        expect(loginMock).not.toHaveBeenCalled();
    });

    it('已有登录流程进行中时返回冲突且不开第二个浏览器', async () => {
        const held = deferred<void>();
        expect(loginMutex.tryRun(() => held.promise)).not.toBeNull();
        const registry = new WikiRegistryImpl({ ci: wikiConfig('ci', sessionFile) }, false);
        const ctx = makeCtx(registry, 'ci', vi.fn());

        const result = await bwikiLogin.handle({}, ctx);

        expect(result.isError).toBe(true);
        expect(envelopeOf(result).category).toBe('conflict');
        expect(loginMock).not.toHaveBeenCalled();

        held.resolve();
        await vi.waitFor(() => expect(loginMutex.isBusy()).toBe(false));
    });

    it('身份校验失败时不写会话、不标记已登录', async () => {
        identityState.failure = new Error('wiki 未识别登录态');
        loginMock.mockResolvedValue({ cookie: 'SESSDATA=abc', userId: '100000000' });
        const registry = new WikiRegistryImpl({ ci: wikiConfig('ci', sessionFile) }, false);
        const markAuthenticated = vi.fn();
        const ctx = makeCtx(registry, 'ci', markAuthenticated);

        await expect(bwikiLogin.handle({}, ctx)).rejects.toThrow('wiki 未识别登录态');

        expect(existsSync(sessionFile)).toBe(false);
        expect(markAuthenticated).not.toHaveBeenCalled();
    });

    it('默认站点不在配置中时返回 invalid_input 且不开浏览器', async () => {
        const registry = new WikiRegistryImpl(
            { other: wikiConfig('other', join(dir, 'other.json')) },
            false,
        );
        const ctx = makeCtx(registry, 'ci', vi.fn());

        const result = await bwikiLogin.handle({}, ctx);

        expect(result.isError).toBe(true);
        expect(envelopeOf(result).category).toBe('invalid_input');
        expect(loginMock).not.toHaveBeenCalled();
    });
});
