/**
 * 启动期会话校验。认证失败不结束进程，转为未登录态交由登录门处理。
 *
 * 判定依据是 `userinfo.name` 是否为数字 UID，不能用 `anon` 或 `id`。
 */

import { Mwn } from 'mwn';
import { DEFAULT_SESSION_FILE, loadConfigFromFile, type WikiConfig } from '../config/loadConfig.ts';
import { callDeadline, WIKI_CONNECT_TIMEOUT_MS } from '../runtime/callDeadline.ts';
import { USER_AGENT } from '../runtime/constants.ts';
import { withCallBounds } from '../wikis/abortableMwn.ts';
import { readSessionFile, wikiCookiePartsFor, type StoredSession } from './cookie.ts';

class NoSessionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'NoSessionError';
    }
}

/**
 * 读取已存会话并确认其有效。无效时返回 null，不抛出。
 *
 * 供启动期使用：无会话不阻止启动，首次工具调用时会触发登录流程。
 */
const readStoredSessionIfValid = async (
    file: string = DEFAULT_SESSION_FILE,
): Promise<StoredSession | null> => {
    const session = await readSessionFile(file);
    if (!session) {
        return null;
    }

    let name: string | undefined;
    try {
        name = await probeIdentity(session);
    } catch {
        // 网络问题时视为无效，保持未登录态；首次调用会重新触发登录。
        return null;
    }

    // 数字即 UID；其他（如 IP 地址）表示会话已失效。
    if (!name || !/^\d{5,}$/.test(name)) {
        return null;
    }
    return session;
};

/**
 * 询问某个已配置 wiki 当前身份。任一站点的结论对全部有效。
 *
 * 与常规调用一样受连接预算约束：wiki 不可达时 30s 内放弃，
 * 不阻塞启动。
 */
const probeIdentity = async (session: StoredSession): Promise<string | undefined> => {
    const { apiUrl } = firstWikiEndpoint();
    const bot = new Mwn({ apiUrl, userAgent: USER_AGENT });
    for (const cookie of wikiCookiePartsFor(session)) {
        try {
            // 不写 Domain，使其为 host-only。
            await bot.cookieJar.setCookie(`${cookie}; Path=/`, apiUrl);
        } catch {
            // 格式错误的条目不中断启动，由下方探测判断是否有可用凭证。
        }
    }
    // 必须在 withCallBounds 视图上调用：直接调用会绕过连接预算。
    const bounded = withCallBounds(bot, callDeadline(WIKI_CONNECT_TIMEOUT_MS, 'connecting'));
    const user = await bounded.userinfo();
    return user?.name ?? user?.userName;
};

/**
 * 第一个已配置 wiki 的端点。直接读配置，不为一次探测构造 AppState。
 */
const firstWikiEndpoint = (): { apiUrl: string } => {
    const config = loadConfigFromFile();
    const configured = Object.keys(config.wikis);
    const firstKey = config.defaultWiki !== '' ? config.defaultWiki : configured[0];
    if (firstKey === undefined) {
        throw new Error('No wikis configured');
    }
    const wiki: WikiConfig | undefined = config.wikis[firstKey];
    if (wiki === undefined) {
        throw new Error(`Wiki "${firstKey}" not found in configuration`);
    }
    return { apiUrl: `${wiki.server}${wiki.scriptpath}/api.php` };
};

export { NoSessionError, readStoredSessionIfValid, probeIdentity };
