/**
 * 登录门的单元测试。
 *
 * 浏览器登录全部 mock 掉：只验证登录门自身的状态机——并发共享、
 * 互斥、陈旧结果丢弃、登出清理。
 */

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionLiveness } from '../src/bwiki/liveness.ts';
import { LoginGateImpl, LoginMutex, loginMutex } from '../src/bwiki/loginGate.ts';
import { loginViaOfficialPage } from '../src/bwiki/passportLogin.ts';

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

const makeGate = (): {
    gate: LoginGateImpl;
    invalidatePassportSession: ReturnType<typeof vi.fn>;
} => {
    const invalidatePassportSession = vi.fn();
    const gate = new LoginGateImpl(sessionFile, { invalidatePassportSession });
    return { gate, invalidatePassportSession };
};

beforeEach(async () => {
    sessionLiveness.reset();
    vi.clearAllMocks();
    dir = await mkdtemp(join(tmpdir(), 'bwiki-login-gate-'));
    sessionFile = join(dir, 'session.json');
});

afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
});

describe('markAuthenticated', () => {
    it('记录身份、复位失效记录并丢弃旧 provider 缓存', () => {
        const { gate, invalidatePassportSession } = makeGate();
        sessionLiveness.markDead('过期');
        expect(sessionLiveness.deathReason).not.toBeNull();

        gate.markAuthenticated('100000000');

        expect(gate.isLoggedIn()).toBe(true);
        expect(sessionLiveness.deathReason).toBeNull();
        expect(sessionLiveness.identity).toBe('100000000');
        expect(invalidatePassportSession).toHaveBeenCalledTimes(1);
    });
});

describe('ensureLoggedIn', () => {
    it('已登录时直接放行', () => {
        const { gate } = makeGate();
        gate.markAuthenticated('100000000');

        expect(gate.ensureLoggedIn()).toEqual({ ready: true, message: '' });
        expect(loginMock).not.toHaveBeenCalled();
    });

    it('成功登录后写会话文件并标记已登录', async () => {
        const { gate, invalidatePassportSession } = makeGate();
        loginMock.mockResolvedValue({ cookie: 'SESSDATA=abc; bili_jct=token', userId: '100' });

        expect(gate.ensureLoggedIn().ready).toBe(false);
        await vi.waitFor(() => expect(gate.isLoggedIn()).toBe(true));

        const saved = JSON.parse(await readFile(sessionFile, 'utf8'));
        expect(saved).toEqual({
            passportCookie: 'SESSDATA=abc; bili_jct=token',
            wikiCookie: '',
            userId: '100',
            savedAt: expect.any(Number),
        });
        expect(sessionLiveness.identity).toBe('100');
        // 登录门不会见 mwn 缓存：登录成功后必须让 provider 重新读会话。
        expect(invalidatePassportSession).toHaveBeenCalled();
    });

    it('并发调用只打开一个登录窗口', async () => {
        const { gate } = makeGate();
        const login = deferred<{ cookie: string; userId: string }>();
        loginMock.mockReturnValue(login.promise);

        const first = gate.ensureLoggedIn();
        const second = gate.ensureLoggedIn();

        expect(first.ready).toBe(false);
        expect(second.ready).toBe(false);
        // 首个调用方是「刚打开登录页」，第二个才是「已在进行中」。
        expect(first.message).toContain('需要登录');
        expect(second.message).toContain('登录已在进行中');
        expect(loginMock).toHaveBeenCalledTimes(1);

        login.resolve({ cookie: 'SESSDATA=abc', userId: '100' });
        await vi.waitFor(() => expect(gate.isLoggedIn()).toBe(true));
    });

    it('别的登录流程占用互斥锁时不再开浏览器', async () => {
        const { gate } = makeGate();
        const held = deferred<void>();
        expect(loginMutex.tryRun(() => held.promise)).not.toBeNull();

        const result = gate.ensureLoggedIn();

        expect(result.ready).toBe(false);
        expect(result.message).toContain('登录已在进行中');
        expect(loginMock).not.toHaveBeenCalled();

        held.resolve();
        await vi.waitFor(() => expect(loginMutex.isBusy()).toBe(false));
    });

    it('登录返回空 cookie 时拒绝并保持未登录', async () => {
        const { gate } = makeGate();
        loginMock.mockResolvedValue({ cookie: '', userId: '100' });

        gate.ensureLoggedIn();
        await vi.waitFor(() => expect(loginMutex.isBusy()).toBe(false));

        expect(gate.isLoggedIn()).toBe(false);
        expect(existsSync(sessionFile)).toBe(false);
    });

    it('BWIKI_MCP_NO_BROWSER_LOGIN=1 时不打开浏览器', () => {
        const { gate } = makeGate();
        vi.stubEnv('BWIKI_MCP_NO_BROWSER_LOGIN', '1');

        const result = gate.ensureLoggedIn();

        expect(result.message).toContain('禁止打开浏览器');
        expect(loginMock).not.toHaveBeenCalled();
    });

    it('restartLogin 复位登录态并重新走登录流程', async () => {
        const { gate } = makeGate();
        gate.markAuthenticated('100');
        const login = deferred<{ cookie: string; userId: string }>();
        loginMock.mockReturnValue(login.promise);

        expect(gate.restartLogin().ready).toBe(false);
        expect(gate.isLoggedIn()).toBe(false);
        expect(loginMock).toHaveBeenCalledTimes(1);

        login.resolve({ cookie: 'SESSDATA=new', userId: '200' });
        await vi.waitFor(() => expect(gate.isLoggedIn()).toBe(true));
    });
});

describe('forget', () => {
    it('删除会话文件并复位登录态', async () => {
        const { gate, invalidatePassportSession } = makeGate();
        await writeFile(sessionFile, JSON.stringify({ userId: '100' }), 'utf8');
        gate.markAuthenticated('100');

        await gate.forget();

        expect(existsSync(sessionFile)).toBe(false);
        expect(gate.isLoggedIn()).toBe(false);
        expect(sessionLiveness.identity).toBeNull();
        expect(invalidatePassportSession).toHaveBeenCalled();
    });

    it('丢弃在途登录的过期结果', async () => {
        const { gate } = makeGate();
        const login = deferred<{ cookie: string; userId: string }>();
        loginMock.mockReturnValue(login.promise);

        gate.ensureLoggedIn();
        expect(loginMutex.isBusy()).toBe(true);

        await gate.forget();
        // 登出之后浏览器才完成登录：结果不应生效，也不应落盘。
        login.resolve({ cookie: 'SESSDATA=stale', userId: '999' });
        await vi.waitFor(() => expect(loginMutex.isBusy()).toBe(false));

        expect(gate.isLoggedIn()).toBe(false);
        expect(sessionLiveness.identity).toBeNull();
        expect(existsSync(sessionFile)).toBe(false);
    });

    it('forget 之后可以重新开始登录', async () => {
        const { gate } = makeGate();
        loginMock.mockResolvedValue({ cookie: 'SESSDATA=abc', userId: '100' });

        gate.ensureLoggedIn();
        await vi.waitFor(() => expect(gate.isLoggedIn()).toBe(true));
        await gate.forget();

        gate.ensureLoggedIn();
        await vi.waitFor(() => expect(gate.isLoggedIn()).toBe(true));
        expect(loginMock).toHaveBeenCalledTimes(2);
    });
});

describe('LoginMutex', () => {
    it('空闲时执行，忙时返回 null', async () => {
        const mutex = new LoginMutex();
        const held = deferred<string>();
        const first = mutex.tryRun(() => held.promise);

        expect(first).not.toBeNull();
        expect(mutex.isBusy()).toBe(true);
        expect(mutex.tryRun(async () => 'second')).toBeNull();

        held.resolve('first');
        await expect(first).resolves.toBe('first');
        await vi.waitFor(() => expect(mutex.isBusy()).toBe(false));
        await expect(mutex.tryRun(async () => 'third')).resolves.toBe('third');
    });
});
