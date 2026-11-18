import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { Identity } from '../bwiki/identity.ts';
import { loginMutex } from '../bwiki/loginGate.ts';
import { loginViaOfficialPage } from '../bwiki/passportLogin.ts';
import { writeSessionFile } from '../bwiki/sessionFile.ts';
import { DEFAULT_SESSION_FILE } from '../config/loadConfig.ts';
import type { ToolContext } from '../runtime/context.ts';
import type { Tool } from '../runtime/tool.ts';

/**
 * 以 bilibili 账号登录 BWiki。
 *
 * 唯一无需会话即可运行的工具。打开官方登录页，由用户自行完成登录，
 * 再通过 DevTools 协议取出 HttpOnly 的 SESSDATA。
 */

const inputSchema = {} as const;

type LoginArgs = z.infer<z.ZodObject<typeof inputSchema>>;

interface LoginResult {
    state: string;
    userId: string;
    canEdit: boolean;
    sessionFile: string;
    message: string;
}

/** 无人值守环境不弹浏览器，提示改用命令行登录。 */
const NO_BROWSER_MESSAGE =
    '当前环境禁止打开浏览器（BWIKI_MCP_NO_BROWSER_LOGIN=1）。' +
    '请在命令行运行 bwiki-mcp-server login 完成登录，然后重试。';

const bwikiLogin: Tool<typeof inputSchema> = {
    name: 'bwiki-login',
    description:
        'Opens the official bilibili passport login page in a local browser (Edge or Chrome already installed on this machine) and waits for the login to complete. Any bilibili login method works: QR scan, password, SMS, WeChat, Weibo or QQ. Once the wiki recognizes the session it is saved to disk, so later tool calls run as this user without logging in again. The window stays open until login finishes or 180 seconds elapse. The only tool that works before a session exists.',
    inputSchema,
    annotations: {
        title: 'Log in to BWiki',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
    },
    // 非 wiki 相关：会话建立前没有目标站点。
    wikiScoped: false,
    failureVerb: 'log in',

    async handle(_args: LoginArgs, ctx: ToolContext): Promise<CallToolResult> {
        if (process.env.BWIKI_MCP_NO_BROWSER_LOGIN === '1') {
            ctx.logger.info('bwiki-login: browser login disabled by BWIKI_MCP_NO_BROWSER_LOGIN');
            return ctx.format.error('authentication', NO_BROWSER_MESSAGE);
        }

        // 会话文件属于配置（或平台默认），不在这里重读配置文件。
        const key = ctx.activeWiki.getDefaultKey();
        const wiki = ctx.wikis.get(key);
        if (!wiki) {
            return ctx.format.invalidInput(
                `Wiki "${key}" is not present in the configuration, cannot log in.`,
            );
        }
        const apiUrl = `${wiki.server}${wiki.scriptpath}/api.php`;
        const sessionFile = wiki.passportSessionFile || DEFAULT_SESSION_FILE;

        // 与登录门共用一把锁：同一时刻只开一个登录窗口，避免两个浏览器抢登录。
        const started = loginMutex.tryRun(async () => loginViaOfficialPage());
        if (started === null) {
            return ctx.format.conflict(
                '登录已在进行中：请先完成已打开的 bilibili 登录页，成功后重试。',
            );
        }

        // 先确认浏览器存在，避免页面打不开而挂住。
        const result = await started;

        // 先换取 wiki 会话 cookie 再保存，此时才能确认身份。
        const identity = new Identity(apiUrl);
        const established = await identity.establish(result.cookie);

        await writeSessionFile(sessionFile, {
            passportCookie: result.cookie,
            wikiCookie: established.wikiCookie,
            userId: established.name,
            savedAt: Date.now(),
        });
        // 通知登录门：会话已就绪，后续调用无需再走登录门。
        ctx.loginGate.markAuthenticated(established.name);
        ctx.logger.info(
            `bwiki-login: logged in as ${established.name}, session written to ${sessionFile}`,
        );

        const payload: LoginResult = {
            state: 'confirmed',
            userId: established.name,
            canEdit: established.canEdit,
            sessionFile,
            message: `登录成功，身份：${established.name}`,
        };
        return ctx.format.ok(payload);
    },
};

export { bwikiLogin };
