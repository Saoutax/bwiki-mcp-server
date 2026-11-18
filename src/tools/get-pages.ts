import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Mwn } from 'mwn';
import { z } from 'zod';
import { contentMaxBytes, truncateByBytes, type TruncationInfo } from '../results/truncation.ts';
import type { ToolContext } from '../runtime/context.ts';
import type { Tool } from '../runtime/tool.ts';
import { sectionContentTruncation } from '../services/sectionMarker.ts';
import { buildPageUrl } from '../wikis/utils.ts';

const MAX_TITLES = 50;

enum BatchContentFormat {
    source = 'source',
    none = 'none',
}

interface PageEntry {
    requestedTitle?: string;
    pageId?: number;
    title?: string;
    redirectedFrom?: string;
    latestRevisionId?: number;
    latestRevisionTimestamp?: string;
    contentModel?: string;
    url?: string;
    source?: string;
    truncation?: TruncationInfo;
}

interface PageRev {
    revid?: number;
    timestamp?: string;
    contentmodel?: string;
    content?: string;
    slots?: {
        main?: { contentmodel?: string; content?: string; size?: number };
    };
}

interface ApiPageLike {
    pageid?: number;
    title: string;
    missing?: boolean;
    invalid?: boolean;
    revisions?: PageRev[];
}

type Alias = { from: string; to: string };

type FetchResult = {
    byResolvedTitle: Map<string, ApiPageLike>;
    aliasTo: Map<string, string>;
    redirectFrom: Set<string>;
};

type PendingTruncation = {
    entryIndex: number;
    title: string;
    returnedBytes: number;
    totalBytes: number;
};

const inputSchema = {
    titles: z.array(z.string()).describe(`Array of wiki page titles (1..${MAX_TITLES})`),
    content: z
        .nativeEnum(BatchContentFormat)
        .optional()
        .default(BatchContentFormat.source)
        .describe('Type of content to return; "none" returns metadata only'),
    metadata: z
        .boolean()
        .optional()
        .default(false)
        .describe('Whether to include metadata (page ID, revision info) in the response'),
    followRedirects: z
        .boolean()
        .optional()
        .default(true)
        .describe(
            'Follow wiki redirects. When true (default), redirect targets are returned with a "Redirected from:" line in the metadata. Set false to fetch redirect pseudo-pages as-is (sync-fidelity).',
        ),
} as const;

type GetPagesArgs = z.infer<z.ZodObject<typeof inputSchema>>;

const validateArgs = ({ titles, content, metadata }: GetPagesArgs): string | undefined => {
    if (titles.length === 0) {
        return 'titles must contain at least one entry';
    }
    if (titles.length > MAX_TITLES) {
        return `titles must contain at most ${MAX_TITLES} entries`;
    }
    if (content === BatchContentFormat.none && !metadata) {
        return 'When content is set to "none", metadata must be true';
    }
    return undefined;
};

const resolveChain = (
    requested: string,
    aliasTo: Map<string, string>,
    redirectFrom: Set<string>,
): { resolved: string; viaRedirect: boolean } => {
    let cur = requested;
    let viaRedirect = false;
    const seen = new Set<string>();
    while (aliasTo.has(cur) && !seen.has(cur)) {
        seen.add(cur);
        if (redirectFrom.has(cur)) {
            viaRedirect = true;
        }
        cur = aliasTo.get(cur)!;
    }
    return { resolved: cur, viaRedirect };
};

const normalisePage = (page: ApiPageLike, ctx: ToolContext): ApiPageLike => {
    if (page.revisions) {
        page.revisions = page.revisions.map(rev => ctx.revision.normalise(rev) as PageRev);
    }
    return page;
};

const fetchPages = async (
    mwn: Mwn,
    ctx: ToolContext,
    args: GetPagesArgs,
    rvprop: string,
): Promise<FetchResult> => {
    const result: FetchResult = {
        byResolvedTitle: new Map(),
        aliasTo: new Map(),
        redirectFrom: new Set(),
    };
    if (!args.followRedirects) {
        // 不跟随重定向，原样返回重定向伪页面。
        // 不用 mwn.read：它会丢弃 normalized，别名与请求标题对不上。
        const response = await mwn.request({
            action: 'query',
            titles: args.titles,
            prop: 'revisions',
            rvprop,
            rvslots: 'main',
            redirects: false,
            formatversion: '2',
        });
        const query = response?.query;
        if (!query) {
            return result;
        }
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
        for (const entry of (query.normalized ?? []) as Alias[]) {
            result.aliasTo.set(entry.from, entry.to);
        }
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
        for (const page of (query.pages ?? []) as ApiPageLike[]) {
            result.byResolvedTitle.set(page.title, normalisePage(page, ctx));
        }
        return result;
    }
    const responses = await mwn.massQuery(
        {
            action: 'query',
            titles: args.titles,
            prop: 'revisions',
            rvprop,
            rvslots: 'main',
            redirects: true,
            formatversion: '2',
        },
        'titles',
    );
    for (const response of responses) {
        const query = response?.query;
        if (!query) {
            continue;
        }
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
        for (const entry of (query.normalized ?? []) as Alias[]) {
            result.aliasTo.set(entry.from, entry.to);
        }
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
        for (const entry of (query.redirects ?? []) as Alias[]) {
            result.aliasTo.set(entry.from, entry.to);
            result.redirectFrom.add(entry.from);
        }
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
        for (const page of (query.pages ?? []) as ApiPageLike[]) {
            result.byResolvedTitle.set(page.title, normalisePage(page, ctx));
        }
    }
    return result;
};

const buildPageEntry = async (
    requested: string,
    page: ApiPageLike,
    viaRedirect: boolean,
    args: GetPagesArgs,
    ctx: ToolContext,
): Promise<PageEntry> => {
    const rev = page.revisions?.[0];
    const entry: PageEntry = {
        pageId: page.pageid,
        title: page.title,
        url: await buildPageUrl(ctx, page.title),
        ...(requested !== page.title ? { requestedTitle: requested } : {}),
        ...(viaRedirect ? { redirectedFrom: requested } : {}),
        ...(args.metadata
            ? {
                  latestRevisionId: rev?.revid,
                  latestRevisionTimestamp: rev?.timestamp,
                  contentModel: rev?.contentmodel,
              }
            : {}),
    };
    if (args.content === BatchContentFormat.source && rev?.content !== undefined) {
        entry.source = rev.content;
    }
    return entry;
};

// 字节预算按整个响应计算，而非逐页。
// 页面保持完整并按请求顺序返回；第一个超出预算的页面起只报名称。
// 页面保持完整，只可能截断第一页，且仅统计正文。
const applyResponseBudget = (entries: PageEntry[], pending: PendingTruncation[]): string[] => {
    const budget = contentMaxBytes();
    let used = 0;
    let keptABody = false;
    for (const [index, entry] of entries.entries()) {
        if (entry.source === undefined) {
            continue;
        }
        const size = Buffer.byteLength(entry.source, 'utf8');
        // 以是否已保留正文为准，而非位置：前一项可能本就无正文。
        if (!keptABody && size > budget) {
            const truncated = truncateByBytes(entry.source, budget);
            entry.source = truncated.text;
            used = truncated.returnedBytes;
            keptABody = true;
            pending.push({
                entryIndex: index,
                title: entry.title ?? entry.requestedTitle ?? '',
                returnedBytes: truncated.returnedBytes,
                totalBytes: truncated.totalBytes,
            });
            continue;
        }
        if (used + size > budget) {
            // 按调用方给出的名称列出。
            const omitted = entries.slice(index).map(e => e.requestedTitle ?? e.title ?? '');
            entries.length = index;
            return omitted;
        }
        used += size;
        keptABody = true;
    }
    return [];
};

// 续读标记直接列出来包含的页面名，而非报告页数上限。
// 以数组交付：标题可含逗号，也可含管道符，拼接后再拆分无法还原。
const omittedPagesTruncation = (returnedCount: number, omitted: string[]): TruncationInfo => ({
    reason: 'more-available',
    returnedCount,
    itemNoun: 'pages',
    toolName: 'get-pages',
    continueWith: { param: 'titles', value: omitted },
});

const applyTruncations = async (
    mwn: Mwn,
    ctx: ToolContext,
    entries: PageEntry[],
    pending: PendingTruncation[],
): Promise<void> => {
    if (pending.length === 0) {
        return;
    }
    const outlines = await Promise.all(pending.map(p => ctx.sections.list(mwn, p.title)));
    pending.forEach((p, i) => {
        entries[p.entryIndex].truncation = sectionContentTruncation({
            entries: outlines[i],
            // get-pages 读取整页，可收窄的只有节。
            section: undefined,
            itemNoun: 'wikitext',
            toolName: 'get-pages',
            returnedBytes: p.returnedBytes,
            totalBytes: p.totalBytes,
        });
    });
};

const assembleEntries = async (
    args: GetPagesArgs,
    fetched: FetchResult,
    ctx: ToolContext,
): Promise<{
    entries: PageEntry[];
    missing: string[];
    invalid: string[];
    pending: PendingTruncation[];
}> => {
    const entryPromises: Promise<PageEntry>[] = [];
    const emitted = new Set<string>();
    const missing: string[] = [];
    const missingSeen = new Set<string>();
    const invalid: string[] = [];
    const invalidSeen = new Set<string>();
    const pending: PendingTruncation[] = [];
    for (const requested of args.titles) {
        // 归一化不跟随重定向：只有在 redirects:true 时 aliasTo 才含重定向边。
        const { resolved, viaRedirect } = resolveChain(
            requested,
            fetched.aliasTo,
            fetched.redirectFrom,
        );
        const page = fetched.byResolvedTitle.get(resolved);
        if (!page || page.missing) {
            if (!missingSeen.has(requested)) {
                missingSeen.add(requested);
                missing.push(requested);
            }
            continue;
        }
        if (page.invalid === true) {
            // 与 missing 一样按请求的标题报告，便于调用方定位入参。
            if (!invalidSeen.has(requested)) {
                invalidSeen.add(requested);
                invalid.push(requested);
            }
            continue;
        }
        if (emitted.has(page.title)) {
            continue;
        }
        emitted.add(page.title);
        entryPromises.push(buildPageEntry(requested, page, viaRedirect, args, ctx));
    }
    const entries = await Promise.all(entryPromises);
    return { entries, missing, invalid, pending };
};

const getPages: Tool<typeof inputSchema> = {
    name: 'get-pages',
    description: `Returns multiple wiki pages in one call (wikitext source or metadata only). Suited to reading a cluster of related pages, diffing a page family, or syncing pages to local storage. Accepts up to ${MAX_TITLES} titles; missing pages are reported inline (not as errors), and titles the wiki rejects as invalid are reported separately under invalid. One byte budget covers the whole response, 75000 bytes by default: pages come back whole in the order asked for until it is spent, and the pages past that point are named rather than returned, so a follow-up call for those names fetches the rest. Only a first page larger than the budget on its own is truncated, with a marker reporting how much of it was returned and which sections a narrower read can target. For a single page or HTML output, use get-page. requestedTitle is included only when it differs from the resolved title.`,
    inputSchema,
    annotations: {
        title: 'Get pages',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
    },
    failureVerb: 'retrieve pages',

    async handle(args, ctx: ToolContext): Promise<CallToolResult> {
        const validationError = validateArgs(args);
        if (validationError) {
            return ctx.format.invalidInput(validationError);
        }

        const mwn = await ctx.mwn();
        const rvprop =
            args.content === BatchContentFormat.source
                ? 'ids|timestamp|contentmodel|content'
                : 'ids|timestamp|contentmodel';
        const fetched = await fetchPages(mwn, ctx, args, rvprop);
        const { entries, missing, invalid, pending } = await assembleEntries(args, fetched, ctx);
        const omitted = applyResponseBudget(entries, pending);
        await applyTruncations(mwn, ctx, entries, pending);

        return ctx.format.ok({
            pages: entries,
            ...(missing.length > 0 ? { missing } : {}),
            ...(invalid.length > 0 ? { invalid } : {}),
            ...(omitted.length > 0
                ? { truncation: omittedPagesTruncation(entries.length, omitted) }
                : {}),
        });
    },
};

export { applyResponseBudget, BatchContentFormat, getPages };
