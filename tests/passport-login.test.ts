/**
 * 通行证登录的单元测试。
 *
 * 不开浏览器：puppeteer 全 mock。覆盖 cookie 提取、候选浏览器查找
 * 与失败时的 profile 清理（临时目录最多含登录态，不能留在磁盘上）。
 */

import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    browserCandidates,
    extractLoginCookies,
    findBrowser,
    loginViaOfficialPage,
} from '../src/bwiki/passportLogin.ts';

const { launchMock } = vi.hoisted(() => ({ launchMock: vi.fn() }));

vi.mock('puppeteer-core', () => ({ default: { launch: launchMock } }));

const PROFILE_PREFIX = 'bwiki-mcp-server-login-';

/** 当前临时目录里的登录 profile 目录名。 */
const loginProfileDirs = async (): Promise<string[]> =>
    (await readdir(tmpdir())).filter(name => name.startsWith(PROFILE_PREFIX));

/** 断言本次调用没有留下新的 profile 目录。 */
const expectNoNewProfileDirs = async (before: Set<string>): Promise<void> => {
    const after = await loginProfileDirs();
    expect(after.filter(name => !before.has(name))).toEqual([]);
};

afterEach(() => {
    vi.unstubAllEnvs();
    launchMock.mockReset();
});

describe('extractLoginCookies', () => {
    it('只取 .bilibili.com 上可用的 cookie 并拼成请求头', () => {
        const result = extractLoginCookies([
            { name: 'SESSDATA', value: 'abc', domain: '.bilibili.com' },
            { name: 'bili_jct', value: 'tok', domain: '.bilibili.com' },
            { name: 'DedeUserID', value: '100000000', domain: '.bilibili.com' },
            { name: 'DedeUserID__ckMd5', value: 'md5', domain: '.bilibili.com' },
            { name: 'sid', value: 'sid1', domain: '.bilibili.com' },
            // 别的域或不在白名单的 cookie 不进入请求头。
            { name: 'SESSDATA', value: 'other', domain: '.biligame.com' },
            { name: 'buvid3', value: 'x', domain: '.bilibili.com' },
        ]);

        expect(result).toEqual({
            cookie: 'SESSDATA=abc; bili_jct=tok; DedeUserID=100000000; DedeUserID__ckMd5=md5; sid=sid1',
            userId: '100000000',
        });
    });

    it('userId 缺失时返回空串，不抛错', () => {
        const result = extractLoginCookies([
            { name: 'SESSDATA', value: 'abc', domain: '.bilibili.com' },
        ]);
        expect(result.userId).toBe('');
    });

    it('拼不出 cookie 头时抛出清晰错误', () => {
        expect(() =>
            extractLoginCookies([{ name: 'SESSDATA', value: 'abc', domain: '.biligame.com' }]),
        ).toThrow(/cookie/);
        expect(() => extractLoginCookies([])).toThrow(/cookie/);
    });
});

describe('findBrowser', () => {
    it('BWIKI_MCP_BROWSER_PATH 优先于内置候选', () => {
        vi.stubEnv('BWIKI_MCP_BROWSER_PATH', process.execPath);

        expect(findBrowser()).toEqual({
            executablePath: process.execPath,
            name: 'BWIKI_MCP_BROWSER_PATH',
        });
        expect(browserCandidates()[0]?.executablePath).toBe(process.execPath);
    });

    it('环境变量指向不存在的文件时不采用', () => {
        const bogus = join(tmpdir(), 'definitely-not-a-browser-xyz');
        expect(existsSync(bogus)).toBe(false);
        vi.stubEnv('BWIKI_MCP_BROWSER_PATH', bogus);

        expect(findBrowser()?.executablePath).not.toBe(bogus);
    });

    it('候选列表按路径去重', () => {
        const paths = browserCandidates().map(candidate => candidate.executablePath.toLowerCase());
        expect(new Set(paths).size).toBe(paths.length);
    });
});

describe('loginViaOfficialPage', () => {
    it('取到 SESSDATA 后返回 cookie 并关闭浏览器', async () => {
        vi.stubEnv('BWIKI_MCP_BROWSER_PATH', process.execPath);
        const before = new Set(await loginProfileDirs());

        const page = { goto: vi.fn(async () => undefined) };
        const browser = {
            newPage: vi.fn(async () => page),
            cookies: vi.fn(async () => [
                { name: 'SESSDATA', value: 'abc', domain: '.bilibili.com' },
                { name: 'DedeUserID', value: '100000000', domain: '.bilibili.com' },
            ]),
            close: vi.fn(async () => undefined),
        };
        launchMock.mockResolvedValue(browser);

        const result = await loginViaOfficialPage();

        expect(result).toEqual({
            cookie: 'SESSDATA=abc; DedeUserID=100000000',
            userId: '100000000',
        });
        expect(page.goto).toHaveBeenCalledWith(
            'https://passport.biligame.com/login',
            expect.objectContaining({ waitUntil: 'domcontentloaded' }),
        );
        expect(browser.close).toHaveBeenCalled();
        await expectNoNewProfileDirs(before);
    });

    it('浏览器启动失败时清理临时 profile', async () => {
        vi.stubEnv('BWIKI_MCP_BROWSER_PATH', process.execPath);
        const before = new Set(await loginProfileDirs());
        launchMock.mockRejectedValue(new Error('launch boom'));

        await expect(loginViaOfficialPage()).rejects.toThrow('launch boom');
        await expectNoNewProfileDirs(before);
    });

    it('打开页面失败时关闭浏览器并清理临时 profile', async () => {
        vi.stubEnv('BWIKI_MCP_BROWSER_PATH', process.execPath);
        const before = new Set(await loginProfileDirs());
        const browser = {
            newPage: vi.fn(async () => {
                throw new Error('page boom');
            }),
            cookies: vi.fn(async () => []),
            close: vi.fn(async () => undefined),
        };
        launchMock.mockResolvedValue(browser);

        await expect(loginViaOfficialPage()).rejects.toThrow('page boom');
        expect(browser.close).toHaveBeenCalled();
        await expectNoNewProfileDirs(before);
    });

    it('登录超时后清理临时 profile', async () => {
        vi.stubEnv('BWIKI_MCP_BROWSER_PATH', process.execPath);
        const before = new Set(await loginProfileDirs());
        const browser = {
            newPage: vi.fn(async () => ({ goto: vi.fn(async () => undefined) })),
            cookies: vi.fn(async () => []),
            close: vi.fn(async () => undefined),
        };
        launchMock.mockResolvedValue(browser);
        // 每次取时间跳 1e6 毫秒：算出截止点后的下一次判断必然越过它。
        let clockCalls = 0;
        vi.spyOn(Date, 'now').mockImplementation(() => {
            clockCalls += 1;
            return clockCalls * 1_000_000;
        });

        await expect(loginViaOfficialPage()).rejects.toThrow(/超时/);
        expect(browser.close).toHaveBeenCalled();
        await expectNoNewProfileDirs(before);
    });
});
