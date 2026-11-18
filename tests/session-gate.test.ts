/**
 * 启动期会话探测的单元测试。
 *
 * 这里把 mwn 与配置都替换成替身，只验证接线：
 *  - 探测必须走第一个（默认）站点的 api.php，且不再为一次探测构造 AppState；
 *  - userinfo 必须在连接预算下执行（30s，connecting 阶段），否则不可达站点
 *    会让启动挂住；
 *  - 身份取 name，退回 userName；cookie 以 host-only 形式注入。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredSession } from '../src/bwiki/cookie.ts';

const state = vi.hoisted(() => ({
    instances: [] as unknown[],
    deadlineCalls: [] as Array<{ timeoutMs: number; phase: string }>,
    deadlineSignals: [] as AbortSignal[],
    userinfoResult: { name: '100000000' } as { name?: string; userName?: string } | undefined,
    config: {
        defaultWiki: 'second',
        wikis: {
            first: {
                sitename: '',
                server: 'https://example.org/first',
                articlepath: '/first',
                scriptpath: '',
            },
            second: {
                sitename: '',
                server: 'https://example.org/second',
                articlepath: '/second',
                scriptpath: '',
            },
        },
    } as {
        defaultWiki: string;
        wikis: Record<
            string,
            { server: string; scriptpath: string; sitename?: string; articlepath?: string }
        >;
    },
}));

vi.mock('mwn', () => {
    class FakeMwn {
        public readonly cookieJar = {
            setCookie: async (cookie: string): Promise<void> => {
                this.cookies.push(cookie);
            },
        };
        public readonly cookies: string[] = [];
        public readonly rawRequestSignals: Array<AbortSignal | undefined> = [];
        public constructor(public readonly options: Record<string, unknown>) {
            state.instances.push(this);
        }
        public async rawRequest(options: { signal?: AbortSignal }): Promise<unknown> {
            this.rawRequestSignals.push(options.signal);
            return {};
        }
        public async userinfo(): Promise<{ name?: string; userName?: string } | undefined> {
            await this.rawRequest({});
            return state.userinfoResult;
        }
    }
    return { Mwn: FakeMwn };
});

vi.mock('../src/runtime/callDeadline.ts', () => ({
    WIKI_CALL_TIMEOUT_MS: 150_000,
    WIKI_CONNECT_TIMEOUT_MS: 30_000,
    callDeadline: (timeoutMs: number, phase: string) => {
        state.deadlineCalls.push({ timeoutMs, phase });
        const signal = new AbortController().signal;
        state.deadlineSignals.push(signal);
        return { signal, timeoutMs, phase };
    },
}));

vi.mock('../src/config/loadConfig.ts', () => ({
    DEFAULT_SESSION_FILE: '/tmp/session.json',
    loadConfigFromFile: () => state.config,
}));

// 探测不应再做这件事：若实现退回构造 AppState，这里会立刻抛错。
vi.mock('../src/wikis/state.ts', () => ({
    createAppState: () => {
        throw new Error('probeIdentity must not construct AppState');
    },
}));

const { probeIdentity } = await import('../src/bwiki/sessionGate.ts');

interface FakeInstance {
    readonly options: { apiUrl?: string; userAgent?: string };
    readonly cookies: string[];
    readonly rawRequestSignals: Array<AbortSignal | undefined>;
}

const fakeInstances = (): FakeInstance[] => state.instances as unknown as FakeInstance[];

const session = (overrides: Partial<StoredSession> = {}): StoredSession => ({
    passportCookie: 'SESSDATA=passport',
    wikiCookie: '',
    userId: '100000000',
    savedAt: 0,
    ...overrides,
});

beforeEach(() => {
    state.instances = [];
    state.deadlineCalls = [];
    state.deadlineSignals = [];
    state.userinfoResult = { name: '100000000' };
    state.config = {
        defaultWiki: 'second',
        wikis: {
            first: {
                sitename: '',
                server: 'https://example.org/first',
                articlepath: '/first',
                scriptpath: '',
            },
            second: {
                sitename: '',
                server: 'https://example.org/second',
                articlepath: '/second',
                scriptpath: '',
            },
        },
    };
});

describe('probeIdentity 接线', () => {
    it('使用默认站点的 api.php，且不构造 AppState', async () => {
        await expect(probeIdentity(session())).resolves.toBe('100000000');
        expect(fakeInstances()[0]?.options.apiUrl).toBe('https://example.org/second/api.php');
    });

    it('未设默认站点时用第一个已配置站点', async () => {
        state.config = { ...state.config, defaultWiki: '' };
        await probeIdentity(session());
        expect(fakeInstances()[0]?.options.apiUrl).toBe('https://example.org/first/api.php');
    });

    it('userinfo 在 connecting 阶段的 30s 预算下执行', async () => {
        await probeIdentity(session());

        expect(state.deadlineCalls).toEqual([{ timeoutMs: 30_000, phase: 'connecting' }]);
        const signal = fakeInstances()[0]?.rawRequestSignals[0];
        expect(signal).toBeInstanceOf(AbortSignal);
        // 必须是被 withCallBounds 注入的那份预算信号。
        expect(signal).toBe(state.deadlineSignals[0]);
    });

    it('身份取 name，退回 userName', async () => {
        await expect(probeIdentity(session())).resolves.toBe('100000000');
        state.instances = [];
        state.userinfoResult = { userName: '200000000' };
        await expect(probeIdentity(session())).resolves.toBe('200000000');
        state.instances = [];
        state.userinfoResult = undefined;
        await expect(probeIdentity(session())).resolves.toBeUndefined();
    });

    it('cookie 以 host-only 形式注入', async () => {
        await probeIdentity(session({ wikiCookie: 'a=1; b=2', passportCookie: 'c=3' }));
        expect(fakeInstances()[0]?.cookies).toEqual(['a=1; Path=/', 'b=2; Path=/', 'c=3; Path=/']);
    });

    it('无已配置站点时抛出明确错误', async () => {
        state.config = { defaultWiki: '', wikis: {} };
        await expect(probeIdentity(session())).rejects.toThrow(/No wikis configured/);
    });

    it('默认站点不在配置中时抛出明确错误', async () => {
        state.config = { ...state.config, defaultWiki: 'ghost' };
        await expect(probeIdentity(session())).rejects.toThrow(/ghost/);
    });
});
