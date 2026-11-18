/**
 * 通过本机浏览器完成官方通行证登录。
 *
 * SESSDATA 是 .bilibili.com 上的 HttpOnly cookie，页面脚本与 Node 进程均无法读取，
 * 故由 puppeteer-core 通过 DevTools 协议取出。使用一次性 profile，不触碰用户真实配置。
 */

import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface BrowserChoice {
    executablePath: string;
    name: string;
}

/** 浏览器候选；环境变量覆盖优先级最高，且必须指向真实存在的文件。 */
const browserCandidates = (): BrowserChoice[] => {
    const candidates: BrowserChoice[] = [];

    const fromEnv = process.env.BWIKI_MCP_BROWSER_PATH;
    if (fromEnv) {
        candidates.push({ executablePath: fromEnv, name: 'BWIKI_MCP_BROWSER_PATH' });
    }

    if (process.platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA;
        candidates.push(
            {
                name: 'Edge',
                executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
            },
            {
                name: 'Edge',
                executablePath: 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
            },
            {
                name: 'Chrome',
                executablePath: 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
            },
            {
                name: 'Chrome',
                executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
            },
        );
        if (localAppData) {
            candidates.push(
                {
                    name: 'Chromium',
                    executablePath: join(localAppData, 'Chromium', 'Application', 'chrome.exe'),
                },
                {
                    name: 'Chrome',
                    executablePath: join(
                        localAppData,
                        'Google',
                        'Chrome',
                        'Application',
                        'chrome.exe',
                    ),
                },
            );
        }
    } else if (process.platform === 'darwin') {
        candidates.push(
            {
                name: 'Chrome',
                executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            },
            {
                name: 'Edge',
                executablePath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            },
            {
                name: 'Chromium',
                executablePath: '/Applications/Chromium.app/Contents/MacOS/Chromium',
            },
        );
    } else {
        candidates.push(
            { name: 'Chrome', executablePath: '/usr/bin/google-chrome' },
            { name: 'Chrome', executablePath: '/usr/bin/google-chrome-stable' },
            { name: 'Chromium', executablePath: '/usr/bin/chromium' },
            { name: 'Chromium', executablePath: '/usr/bin/chromium-browser' },
            { name: 'Chromium', executablePath: '/snap/bin/chromium' },
            { name: 'Edge', executablePath: '/usr/bin/microsoft-edge' },
            { name: 'Edge', executablePath: '/usr/bin/microsoft-edge-stable' },
        );
    }

    // 去重（Windows 上路径大小写不敏感），保持优先级顺序。
    const seen = new Set<string>();
    const unique: BrowserChoice[] = [];
    for (const candidate of candidates) {
        const key =
            process.platform === 'win32'
                ? candidate.executablePath.toLowerCase()
                : candidate.executablePath;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        unique.push(candidate);
    }
    return unique;
};

/** 返回第一个真实存在的候选；都不存在时返回 null。 */
const findBrowser = (): BrowserChoice | null => {
    for (const candidate of browserCandidates()) {
        if (candidate.executablePath && existsSync(candidate.executablePath)) {
            return candidate;
        }
    }
    return null;
};

interface OfficialLoginResult {
    /** Cookie header value for the wiki, e.g. "SESSDATA=...; bili_jct=...". */
    cookie: string;
    /** The bilibili UID. */
    userId: string;
}

/** How long to wait for the user to finish logging in. */
const LOGIN_TIMEOUT_MS = 180_000;

/** Polling interval while waiting for the credential to appear. */
const POLL_INTERVAL_MS = 2000;

/** 只取 .bilibili.com 上可通过认证的 cookie。 */
const LOGIN_COOKIE_NAMES = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid'];

const isSessdata = (cookie: any): boolean =>
    /bilibili|bigfun/.test(String(cookie.domain)) && cookie.name === 'SESSDATA';

/**
 * 从浏览器 cookie 列表拼出请求头与 bilibili UID。纯函数，便于单测。
 *
 * Cookie 头为空说明登录尚未生效（或 cookie 落在无法使用的域上），
 * 直接报错而不是写入一个永远认证不了的会话文件。
 */
const extractLoginCookies = (cookies: any[]): OfficialLoginResult => {
    const wanted = cookies.filter(
        (c: any) => c.domain === '.bilibili.com' && LOGIN_COOKIE_NAMES.includes(c.name),
    );
    const cookie = wanted.map((c: any) => `${c.name}=${c.value}`).join('; ');
    if (!cookie) {
        throw new Error('登录页未返回可用的 cookie（SESSDATA 等），请重试。');
    }
    const userId = cookies.find((c: any) => c.name === 'DedeUserID')?.value ?? '';
    return { cookie, userId };
};

/**
 * 打开通行证登录页并等待登录完成。浏览器窗口保持可见。
 *
 * profile 目录与浏览器放在同一个 try/finally 内：任一步失败都会清理，
 * 不在磁盘上留下含登录态的残留 profile。
 */
const loginViaOfficialPage = async (): Promise<OfficialLoginResult> => {
    const choice = findBrowser();
    if (!choice) {
        throw new Error(
            '找不到本机浏览器。请安装 Edge 或 Chrome 后重试，' +
                '或用 BWIKI_MCP_BROWSER_PATH 指定浏览器可执行文件路径。',
        );
    }

    // 按需加载，缺失时给出明确错误。
    let puppeteer: any;
    try {
        puppeteer = (await import('puppeteer-core')).default;
    } catch {
        throw new Error('puppeteer-core 未安装。运行 pnpm install 后重试。');
    }

    let profileDir: string | null = null;
    let browser: any = null;
    try {
        // 一次性 profile：不触碰用户真实配置，也避免残留会话跳过登录。
        profileDir = await mkdtemp(join(tmpdir(), 'bwiki-mcp-server-login-'));

        browser = await puppeteer.launch({
            executablePath: choice.executablePath,
            headless: false,
            defaultViewport: null,
            userDataDir: profileDir,
            args: ['--start-maximized', '--no-first-run', '--no-default-browser-check'],
        });

        const page = await browser.newPage();
        await page.goto('https://passport.biligame.com/login', {
            waitUntil: 'domcontentloaded',
            timeout: 60_000,
        });

        const deadline = Date.now() + LOGIN_TIMEOUT_MS;
        while (Date.now() < deadline) {
            const cookies = await browser.cookies();
            if (cookies.some(isSessdata)) {
                return extractLoginCookies(cookies);
            }
            await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
        }

        throw new Error('等待登录超时（180 秒）');
    } finally {
        if (browser !== null) {
            await browser.close().catch(() => undefined);
        }
        if (profileDir !== null) {
            await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
        }
    }
};

export { browserCandidates, extractLoginCookies, findBrowser, loginViaOfficialPage };
export type { BrowserChoice, OfficialLoginResult };
