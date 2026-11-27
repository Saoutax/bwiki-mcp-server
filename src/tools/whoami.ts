import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ToolContext } from '../runtime/context.ts';
import type { Tool } from '../runtime/tool.ts';

const inputSchema = {
    includeRights: z
        .boolean()
        .optional()
        .describe(
            'Also return the full list of user rights granted on this wiki (a long list). Defaults to false.',
        ),
} as const;

type WhoamiArgs = z.infer<z.ZodObject<typeof inputSchema>>;

interface RawUserinfo {
    id: number;
    name: string;
    anon?: boolean;
    groups?: string[];
    rights?: string[];
}

interface UserinfoResponse {
    query?: { userinfo?: RawUserinfo };
}

interface WhoamiResult {
    id: number;
    username: string;
    anonymous: boolean;
    groups: string[];
    /**
     * 该账号的编辑是否会进入审核队列。
     * 依据 `skip-moderation` 权限判断；权限列表缺失时省略。
     */
    moderated?: boolean;
    rights?: string[];
}

const whoami: Tool<typeof inputSchema> = {
    name: 'whoami',
    description:
        'Returns the identity the current session is authenticated as on the targeted wiki: the username and the user groups it belongs to. moderated reports whether edits from this account are queued for review by the Moderation extension: true when the account lacks the skip-moderation right, so a write may not appear on the page until a reviewer approves it. Set includeRights to also return the full list of user rights. Use to confirm who edits and uploads will be attributed to before writing — for example, to resolve your own username before building a title under your own user namespace (User:<username>/…). Like every wiki tool it needs the bilibili session bwiki-login stores: with no session the call fails rather than reporting anonymous access.',
    inputSchema,
    annotations: {
        title: 'Who am I',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
    },
    failureVerb: 'read user identity',

    async handle(args: WhoamiArgs, ctx: ToolContext): Promise<CallToolResult> {
        const mwn = await ctx.mwn();
        // rights 总是取回：moderated 依赖它判断，是否返回给调用方由 includeRights 决定。
        const uiprop = 'groups|rights';

        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
        const response = (await mwn.request({
            action: 'query',
            meta: 'userinfo',
            uiprop,
            formatversion: '2',
        })) as UserinfoResponse;

        const userinfo = response.query?.userinfo;
        if (!userinfo) {
            throw new Error('userinfo response did not include user data');
        }

        const result: WhoamiResult = {
            id: userinfo.id,
            username: userinfo.name,
            anonymous: userinfo.anon === true,
            groups: userinfo.groups ?? [],
        };
        if (Array.isArray(userinfo.rights)) {
            result.moderated = !userinfo.rights.includes('skip-moderation');
        }
        if (args.includeRights === true) {
            result.rights = userinfo.rights ?? [];
        }

        return ctx.format.ok(result);
    },
};

export { whoami };
