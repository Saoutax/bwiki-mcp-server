/**
 * 登录门：无会话或会话失效时，为工具调用提供交互式登录。
 *
 * 不阻塞调用方：登录页在后台等待用户操作，本次调用立即返回提示，
 * 用户完成登录后重发请求即可。并发调用共享同一次登录流程。
 */

import { DEFAULT_SESSION_FILE } from '../config/loadConfig.ts';
import { logger } from '../runtime/logger.ts';
import type { MwnProvider } from '../wikis/mwnProvider.ts';
import { sessionLiveness } from './liveness.ts';
import { loginViaOfficialPage } from './passportLogin.ts';
import { removeSessionFile, writeSessionFile } from './sessionFile.ts';

interface LoginGate {
    /** 确保已登录。未登录时启动登录流程并立即返回等待提示。 */
    ensureLoggedIn(): { ready: boolean; message: string };
    /** 强制重新登录：复位登录态后启动登录流程，供会话失效时使用。 */
    restartLogin(): { ready: boolean; message: string };
    /** 清除已存会话并复位登录态，供 logout 使用。 */
    forget(): Promise<void>;
    /** 标记为已登录，由启动期会话校验通过时调用。 */
    markLoggedIn(): void;
    /** 标记为已登录并记录身份，供登录成功后调用。 */
    markAuthenticated(uid: string): void;
    /** 当前是否已登录。 */
    isLoggedIn(): boolean;
}

/**
 * 进程级登录互斥。
 *
 * 浏览器登录窗口同一时刻只应有一个：登录门与 bwiki-login 工具共用此锁，
 * 谁先拿到谁开浏览器，后来者立即得到「已在进行中」而不是再开一个窗口。
 */
class LoginMutex {
    private current: Promise<unknown> | null = null;

    /** 空闲时执行 `fn` 并返回其结果，忙时返回 null。 */
    public tryRun<T>(fn: () => Promise<T>): Promise<T> | null {
        if (this.current !== null) {
            return null;
        }
        const pending = fn();
        this.current = pending;
        // 不沿用 finally 的派生 promise：其 rejection 无人接收会成为未处理拒绝。
        pending
            .catch(() => undefined)
            .finally(() => {
                if (this.current === pending) {
                    this.current = null;
                }
            })
            .catch(() => undefined);
        return pending;
    }

    /** 当前是否有登录流程在跑。 */
    public isBusy(): boolean {
        return this.current !== null;
    }
}

/** 全进程唯一，供登录门与工具共享。 */
const loginMutex = new LoginMutex();

class LoginGateImpl implements LoginGate {
    private inflight: Promise<boolean> | null = null;
    private loggedIn = false;
    private noBrowser = false;
    /** 每次 forget 递增：用于丢弃登录中途已失效的在途结果。 */
    private attempt = 0;

    public constructor(
        private readonly sessionFile: string = DEFAULT_SESSION_FILE,
        private readonly mwnProvider?: Pick<MwnProvider, 'invalidatePassportSession'>,
    ) {}

    public isLoggedIn(): boolean {
        return this.loggedIn;
    }

    /** 标记为已登录，由启动期会话校验通过时调用。 */
    markLoggedIn(): void {
        this.loggedIn = true;
    }

    /** 标记为已登录并记录身份，供登录成功后调用。 */
    public markAuthenticated(uid: string): void {
        sessionLiveness.reset();
        sessionLiveness.setIdentity(uid);
        this.mwnProvider?.invalidatePassportSession();
        this.loggedIn = true;
        this.noBrowser = false;
    }

    /**
     * 强制重新登录。复位登录态后启动登录流程，立即返回。
     *
     * 供会话失效时使用：此时 loggedIn 仍为 true，ensureLoggedIn 会直接放行，
     * 必须显式复位才能重新走登录。
     */
    public restartLogin(): { ready: boolean; message: string } {
        this.loggedIn = false;
        return this.ensureLoggedIn();
    }

    public ensureLoggedIn(): { ready: boolean; message: string } {
        if (this.loggedIn) {
            return { ready: true, message: '' };
        }
        // 启动后立即返回，不在本次调用里等待用户操作。
        // 并发调用共享同一次登录，避免弹出多个浏览器窗口。
        const alreadyRunning = this.inflight !== null;
        const mutexBusy = loginMutex.isBusy();
        if (!alreadyRunning && !mutexBusy) {
            const started = this.startLogin();
            this.inflight = started;
            // 只清理自己的 inflight：forget 之后可能有新的登录在跑。
            const clear = (): void => {
                if (this.inflight === started) {
                    this.inflight = null;
                }
            };
            void started.then(clear, clear);
        }
        return {
            ready: false,
            message: this.noBrowser
                ? '未登录，且当前环境禁止打开浏览器（BWIKI_MCP_NO_BROWSER_LOGIN）。' +
                  '请先在命令行运行 bwiki-mcp-server login 完成登录。'
                : alreadyRunning || mutexBusy
                  ? '登录已在进行中：请在已打开的 bilibili 登录页完成登录，成功后重发本次请求。'
                  : '需要登录：已打开 bilibili 登录页，请在浏览器中完成登录，' +
                    '成功后重发本次请求。若浏览器未弹出，可调用 bwiki-login 工具。',
        };
    }

    private async startLogin(): Promise<boolean> {
        const attempt = this.attempt;
        // 会话曾被判失效时先复位，否则后续 assertAlive 仍会拒绝。
        sessionLiveness.reset();

        // 无人值守环境（测试、CI）不弹浏览器，直接记为失败。
        if (process.env.BWIKI_MCP_NO_BROWSER_LOGIN === '1') {
            logger.info('login gate: browser login disabled by BWIKI_MCP_NO_BROWSER_LOGIN');
            this.noBrowser = true;
            return false;
        }

        // 与 bwiki-login 工具共用一把锁：同一时刻只开一个登录窗口。
        const started = loginMutex.tryRun(async () => loginViaOfficialPage());
        if (started === null) {
            logger.info('login gate: another login is already in progress');
            return false;
        }

        try {
            const result = await started;
            if (attempt !== this.attempt) {
                logger.info('login gate: discarding stale login result');
                return false;
            }
            if (!result.cookie) {
                logger.error('login gate: login returned an empty cookie');
                return false;
            }
            if (!result.userId) {
                logger.error('login gate: no bilibili user id returned');
                return false;
            }
            await writeSessionFile(this.sessionFile, {
                passportCookie: result.cookie,
                // 留空：api.php 直接接受 passport cookie。
                wikiCookie: '',
                userId: result.userId,
                savedAt: Date.now(),
            });
            // 写盘期间被 forget 时，刚写的文件属于过期结果，一并清掉。
            if (attempt !== this.attempt) {
                await removeSessionFile(this.sessionFile).catch(() => undefined);
                logger.info('login gate: discarding stale login result written during logout');
                return false;
            }
            this.markAuthenticated(result.userId);
            logger.info(`login gate: logged in as ${result.userId}`);
            return true;
        } catch (err) {
            logger.error(
                `login gate: login failed: ${err instanceof Error ? err.message : String(err)}`,
            );
            return false;
        }
    }

    public async forget(): Promise<void> {
        this.loggedIn = false;
        this.noBrowser = false;
        // 递增代数：在途登录的结果不再生效。
        this.attempt += 1;
        this.inflight = null;
        sessionLiveness.reset();
        this.mwnProvider?.invalidatePassportSession();
        await removeSessionFile(this.sessionFile).catch(() => undefined);
    }
}

export { LoginGateImpl, LoginMutex, loginMutex };
export type { LoginGate };
