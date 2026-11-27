import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ToolContext } from '../runtime/context.ts';
import type { Tool } from '../runtime/tool.ts';

enum RandomFilter {
    all = 'all',
    redirects = 'redirects',
    nonredirects = 'nonredirects',
}

// formatversion=2 下随机页条目的字段是 id，而非 allpages 的 pageid。
interface RandomPageEntry {
    id: number;
    ns: number;
    title: string;
}

const inputSchema = {
    namespace: z
        .number()
        .int()
        .nonnegative()
        .default(0)
        .describe(
            "Namespace ID to sample from (0 is the main namespace). get-site-info lists a wiki's namespace IDs and their localized names.",
        ),
    filter: z
        .nativeEnum(RandomFilter)
        .default(RandomFilter.nonredirects)
        .describe('Restrict the sample to redirects, to non-redirects, or to all pages'),
    limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(10)
        .describe('Maximum pages to return (1..500, default 10)'),
} as const;

const getRandomPages: Tool<typeof inputSchema> = {
    name: 'get-random-pages',
    description:
        'Returns a random sample of pages from a namespace, each with its title, page ID, and namespace ID. Every call draws a new sample from the pages that exist at request time, so repeated calls with the same arguments return different pages and no ordering is guaranteed. namespace takes a namespace ID (0 is the main namespace); get-site-info reports the IDs and their localized names. filter restricts the sample to redirects, non-redirects, or all pages, and limit caps the sample size. Random sampling is not enumeration: use list-pages to walk a whole namespace in title order, which paginates with continueFrom. This tool does not paginate - there is no continuation token, and a namespace holding fewer pages than limit yields fewer items, possibly none. Only titles, IDs, and namespace IDs are returned - no sizes or timestamps; for page content, use get-page.',
    inputSchema,
    annotations: {
        title: 'Get random pages',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
    },
    failureVerb: 'retrieve random pages',
    target: a => `namespace ${a.namespace}`,

    async handle({ namespace, filter, limit }, ctx: ToolContext): Promise<CallToolResult> {
        const mwn = await ctx.mwn();

        // 线上 BWiki 的过滤参数是 rnfilterredir；rnfilter 不被识别。
        // 不发 rncontinue：随机列表没有有意义的翻页，续读令牌也不回传。
        const params: Record<string, string | number | boolean> = {
            action: 'query',
            list: 'random',
            rnnamespace: namespace,
            rnlimit: limit,
            rnfilterredir: filter,
            formatversion: '2',
        };

        const response = await mwn.request(params);
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
        const raw: RandomPageEntry[] = (response.query?.random ?? []) as RandomPageEntry[];

        return ctx.format.ok({
            pages: raw.map(page => ({
                title: page.title,
                pageId: page.id,
                namespace: page.ns,
            })),
        });
    },
};

export { RandomFilter, getRandomPages };
