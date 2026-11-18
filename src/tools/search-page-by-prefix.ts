import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { TruncationInfo } from '../results/truncation.ts';
import type { ToolContext } from '../runtime/context.ts';
import type { Tool } from '../runtime/tool.ts';
import { resolveSiteInfo } from '../wikis/siteInfo.ts';
import { resolvePrefixForSearch } from '../wikis/titlePrefix.ts';

interface AllPagesEntry {
    pageid: number;
    ns: number;
    title: string;
}

const inputSchema = {
    prefix: z
        .string()
        .describe(
            'Wiki page title prefix. A leading namespace prefix (e.g. "File:" or the wiki\'s localized equivalent) is stripped and used as the namespace filter.',
        ),
    limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe('Maximum number of results to return'),
    namespace: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
            'Namespace ID to restrict the search to. Conflicts with a namespace prefix in `prefix` are rejected.',
        ),
} as const;

const searchPageByPrefix: Tool<typeof inputSchema> = {
    name: 'search-page-by-prefix',
    description:
        'Returns wiki page titles beginning with a given prefix (suited to autocomplete and title lookup). Only titles are returned — no snippets, sizes, or IDs. A namespace prefix on the prefix (such as "File:" or the wiki\'s localized form) is detected, stripped, and used as the namespace filter; it must agree with the explicit namespace filter when both are given. Accepts up to 500 titles per call (default 10); additional matches beyond the cap are flagged in the response. For full-text content search, use search-page.',
    inputSchema,
    annotations: {
        title: 'Search page by prefix',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
    },
    failureVerb: 'retrieve search data',
    target: a => a.prefix,

    async handle({ prefix, limit, namespace }, ctx: ToolContext): Promise<CallToolResult> {
        const siteInfo = await resolveSiteInfo(ctx, ctx.activeWiki.get().key);
        const resolvedPrefix = resolvePrefixForSearch(prefix, namespace, siteInfo);
        if ('error' in resolvedPrefix) {
            return ctx.format.invalidInput(resolvedPrefix.error);
        }

        const mwn = await ctx.mwn();

        // allpages 的 apprefix 只匹配标题文本，命名空间必须通过 apnamespace 单传，
        // 故带前缀的搜索词拆成「命名空间 + 裸前缀」两组参数。
        const params: Record<string, string | number | boolean> = {
            action: 'query',
            list: 'allpages',
            apprefix: resolvedPrefix.prefix,
            formatversion: '2',
        };
        if (limit !== undefined) {
            params.aplimit = limit;
        }
        if (resolvedPrefix.namespace !== undefined) {
            params.apnamespace = resolvedPrefix.namespace;
        }

        const response = await mwn.request(params);
        const pages: AllPagesEntry[] = response.query?.allpages ?? [];

        const truncation: TruncationInfo | null = response.continue
            ? {
                  reason: 'capped-no-continuation',
                  returnedCount: pages.length,
                  limit: limit ?? 10,
                  itemNoun: 'titles',
                  narrowHint: 'narrow the prefix or raise limit (max 500)',
              }
            : null;

        return ctx.format.ok({
            results: pages.map(p => ({
                title: p.title,
                pageId: p.pageid,
                namespace: p.ns,
            })),
            ...(truncation !== null ? { truncation } : {}),
        });
    },
};

export { searchPageByPrefix };
