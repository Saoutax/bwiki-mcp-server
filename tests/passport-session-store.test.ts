/**
 * passport 会话缓存与 cookie 注入的单元测试。
 *
 * 真实会话文件写在临时目录；mwn 用替身，不发任何网络请求。
 * 覆盖点：null/异常不被缓存、成功结果被缓存、wiki cookie 可单独使用、
 * 逐条 await 注入且单条失败只告警不泄凭证。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Mwn } from 'mwn';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WikiConfig } from '../src/config/loadConfig.ts';
import { logger } from '../src/runtime/logger.ts';
import { ActiveWikiImpl } from '../src/wikis/activeWiki.ts';
import { MwnProviderImpl, injectPassportCookie } from '../src/wikis/mwnProvider.ts';
import { WikiRegistryImpl } from '../src/wikis/wikiRegistry.ts';

interface FakeMwnInstance {
    readonly cookies: string[];
    recordAtSiteInfo: string[] | null;
}

const { FakeMwn } = vi.hoisted(() => {
    class FakeMwn {
        public static instances: FakeMwn[] = [];

        public readonly cookies: string[] = [];

        public readonly cookieJar = {
            setCookie: async (raw: string): Promise<void> => {
                this.cookies.push(raw);
            },
        };

        public readonly axiosInstance = {
            defaults: { headers: { common: {} as Record<string, string> } },
        };

        public recordAtSiteInfo: string[] | null = null;

        public request = async (..._args: unknown[]): Promise<unknown> => ({});

        public constructor(public readonly options: Record<string, unknown>) {
            FakeMwn.instances.push(this);
        }

        public async getSiteInfo(): Promise<unknown> {
            // 记下首次请求时 jar 里已有哪些 cookie：验证注入先于请求。
            this.recordAtSiteInfo = [...this.cookies];
            return {};
        }

        public initOAuth(): void {}

        public async getTokensAndSiteInfo(): Promise<unknown> {
            return {};
        }

        public async login(): Promise<void> {}
    }

    return { FakeMwn };
});

vi.mock('mwn', () => ({ Mwn: FakeMwn }));

let dir: string;
let sessionFile: string;

/** 构造一个只服务单个站点的 provider。 */
const makeProvider = (): MwnProviderImpl => {
    const key = 'ci';
    const config: WikiConfig = {
        sitename: '',
        server: 'https://example.invalid/ci',
        articlepath: '/ci',
        scriptpath: '',
        passportSessionFile: sessionFile,
    };
    const registry = new WikiRegistryImpl({ [key]: config }, false);
    const activeWiki = new ActiveWikiImpl(key, registry);
    return new MwnProviderImpl(registry, activeWiki, () => undefined);
};

const writeSession = async (record: Record<string, unknown>): Promise<void> => {
    await writeFile(sessionFile, JSON.stringify(record), 'utf8');
};

const instance = (index: number): FakeMwnInstance => FakeMwn.instances[index] as FakeMwnInstance;

beforeEach(async () => {
    FakeMwn.instances.length = 0;
    dir = await mkdtemp(join(tmpdir(), 'bwiki-session-store-'));
    sessionFile = join(dir, 'session.json');
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe('passport 会话缓存', () => {
    it('无会话时返回 null 且不缓存该结论', async () => {
        const provider = makeProvider();

        await provider.get('ci');
        expect(FakeMwn.instances).toHaveLength(1);
        expect(instance(0).cookies).toEqual([]);

        // 登录成功后写入会话：下一次读取必须重新读盘，而不是复述旧结论。
        await writeSession({ passportCookie: 'SESSDATA=abc', wikiCookie: '', userId: '100' });
        provider.invalidate('ci');
        await provider.get('ci');

        expect(FakeMwn.instances).toHaveLength(2);
        expect(instance(1).recordAtSiteInfo).toContain('SESSDATA=abc; Path=/');
    });

    it('成功读取的会话被缓存，文件删除后仍可用', async () => {
        const provider = makeProvider();
        await writeSession({ passportCookie: 'SESSDATA=abc', wikiCookie: '', userId: '100' });

        await provider.get('ci');
        await rm(sessionFile, { force: true });
        provider.invalidate('ci');
        await provider.get('ci');

        expect(FakeMwn.instances).toHaveLength(2);
        expect(instance(1).recordAtSiteInfo).toContain('SESSDATA=abc; Path=/');
    });

    it('userId 为空的记录视为无会话', async () => {
        const provider = makeProvider();
        await writeSession({ passportCookie: 'SESSDATA=abc', wikiCookie: '', userId: '' });

        await provider.get('ci');
        expect(instance(0).cookies).toEqual([]);
    });

    it('只有 wikiCookie 时也可认证', async () => {
        const provider = makeProvider();
        await writeSession({
            passportCookie: '',
            wikiCookie: 'gamecenter_wiki=sess',
            userId: '100',
        });

        await provider.get('ci');
        expect(instance(0).recordAtSiteInfo).toEqual(['gamecenter_wiki=sess; Path=/']);
    });
});

describe('injectPassportCookie', () => {
    const apiUrl = 'https://example.invalid/ci/api.php';

    it('逐条 await 注入，单条失败只告警且不泄露值', async () => {
        const setCookie = vi.fn(async (raw: string) => {
            if (raw.startsWith('bad=')) {
                throw new Error('invalid cookie');
            }
        });
        const warning = vi.spyOn(logger, 'warning');

        await injectPassportCookie(
            { cookieJar: { setCookie } } as unknown as Mwn,
            'good=1; bad=2; =novalue; novalue=',
            apiUrl,
        );

        expect(setCookie.mock.calls.map(call => call[0])).toEqual([
            'good=1; Path=/',
            'bad=2; Path=/',
        ]);
        expect(warning).toHaveBeenCalledTimes(1);
        const message = String(warning.mock.calls[0]?.[0]);
        expect(message).toContain('bad');
        expect(message).not.toContain('bad=2');
    });

    it('函数返回时所有 setCookie 均已落定', async () => {
        let settled = 0;
        const setCookie = async (_raw: string): Promise<void> => {
            await new Promise(resolve => setTimeout(resolve, 1));
            settled += 1;
        };

        await injectPassportCookie(
            { cookieJar: { setCookie } } as unknown as Mwn,
            'a=1; b=2',
            apiUrl,
        );

        expect(settled).toBe(2);
    });
});
