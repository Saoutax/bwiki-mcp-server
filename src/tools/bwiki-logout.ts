import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { removeSessionFile } from '../bwiki/sessionFile.ts';
import { DEFAULT_SESSION_FILE } from '../config/loadConfig.ts';
import type { ToolContext } from '../runtime/context.ts';
import type { Tool } from '../runtime/tool.ts';

/**
 * 登出 BWiki：删除已保存的会话文件，不结束当前连接。
 */
const inputSchema = {} as const;

type LogoutArgs = z.infer<z.ZodObject<typeof inputSchema>>;

interface LogoutResult {
    message: string;
    removed: string[];
}

const bwikiLogout: Tool<typeof inputSchema> = {
    name: 'bwiki-logout',
    description:
        'Deletes the stored bilibili session from disk, so subsequent tool calls have no credential. Use when finishing with BWiki or switching accounts; run bwiki-login to sign in again. Does not close the connection.',
    inputSchema,
    annotations: {
        title: 'Log out of BWiki',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
    },
    wikiScoped: false,
    failureVerb: 'log out',

    async handle(_args: LogoutArgs, ctx: ToolContext): Promise<CallToolResult> {
        // 当前配置的站点都解析到默认会话路径，仍逐个收集以便将来恢复按站点覆盖。
        const files = new Set<string>([DEFAULT_SESSION_FILE]);
        for (const wiki of Object.values(ctx.wikis.getAll())) {
            if (wiki.passportSessionFile) {
                files.add(wiki.passportSessionFile);
            }
        }

        const removed: string[] = [];
        for (const file of files) {
            try {
                await removeSessionFile(file);
                removed.push(file);
            } catch {
                // 删除失败的文件不出现在 `removed` 中，而非报错：
                // 单个文件被占用不应阻止其余文件删除。
                ctx.logger.warning(`bwiki-logout: could not remove ${file}`);
            }
        }
        // 复位登录态，使后续调用重新走登录门而非继续用旧凭证。
        await ctx.loginGate.forget();
        ctx.logger.info('bwiki-logout: session removed');

        const payload: LogoutResult = {
            message: '已登出',
            removed,
        };
        return ctx.format.ok(payload);
    },
};

export { bwikiLogout };
