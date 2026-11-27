import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Mwn } from 'mwn';
import { z } from 'zod';
import { ContentFormat } from '../results/contentFormat.ts';
import { truncateByBytes, type TruncationInfo } from '../results/truncation.ts';
import type { ToolContext } from '../runtime/context.ts';
import type { Tool } from '../runtime/tool.ts';
import { sectionContentTruncation } from '../services/sectionMarker.ts';
import { toOutlineLines, type SectionEntry } from '../services/sectionService.ts';
import { buildPageUrl } from '../wikis/utils.ts';

const inputSchema = {
    title: z.string().describe('Wiki page title'),
    content: z
        .nativeEnum(ContentFormat)
        .optional()
        .default(ContentFormat.source)
        .describe('Type of content to return'),
    metadata: z
        .boolean()
        .optional()
        .default(false)
        .describe(
            'Whether to include metadata (page ID, revision info, size, section outline) in the response',
        ),
    section: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
            'Section number (0 = lead; 1..N = heading sections). Narrows content to one section.',
        ),
    includePending: z
        .boolean()
        .optional()
        .default(false)
        .describe(
            'Also return your own version of this page that is awaiting moderation, when the wiki holds one. Defaults to false.',
        ),
} as const;

interface PendingPayload {
    wikitext: string;
    comment?: string;
    truncation?: { returnedBytes: number; totalBytes: number };
}

const getPage: Tool<typeof inputSchema> = {
    name: 'get-page',
    description:
        'Returns a single wiki page (wikitext source, rendered HTML, or metadata only). If the title does not exist, an error is returned. Use metadata=true to retrieve the revision ID (for edit-conflict detection), page size, and section outline. Set content="none" to fetch only metadata. Large content is truncated at 75000 bytes by default, with a marker reporting how much of it was returned and which sections a narrower read can target; a follow-up call with section=N fetches a specific section. Set includePending to also return your own version of this page that is awaiting moderation: on wikis with the Moderation extension the live page keeps its old content until that version is approved, so this is how to review what was actually submitted. For more than one page at a time, use get-pages. For a specific historical revision, use get-revision.',
    inputSchema,
    annotations: {
        title: 'Get page',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
    },
    failureVerb: 'retrieve page data',
    target: a => a.title,

    async handle(
        { title, content, metadata, section, includePending },
        ctx: ToolContext,
    ): Promise<CallToolResult> {
        if (content === ContentFormat.none && !metadata) {
            return ctx.format.invalidInput('When content is set to "none", metadata must be true');
        }
        if (section !== undefined && content === ContentFormat.none) {
            return ctx.format.invalidInput('section is not compatible with content="none"');
        }

        const mwn = await ctx.mwn();
        // 待审版本独立于正常读取：被审核的新建页面在 wiki 里仍算不存在。
        const pending =
            includePending === true ? await readPending(ctx, mwn, title, section) : undefined;

        const payload: {
            pageId?: number;
            title?: string;
            latestRevisionId?: number;
            latestRevisionTimestamp?: string;
            contentModel?: string;
            size?: number;
            url?: string;
            sections?: string[];
            source?: string;
            html?: string;
            truncation?: TruncationInfo;
            pending?: PendingPayload;
            pendingNotice?: string;
        } = {};

        const needsReadCall =
            metadata || content === ContentFormat.source || content === ContentFormat.none;
        const needsSource = content === ContentFormat.source;

        let entries: SectionEntry[] | undefined;

        if (needsReadCall) {
            const rvprop = needsSource
                ? 'ids|timestamp|contentmodel|size|content'
                : 'ids|timestamp|contentmodel|size';
            const readParams: Record<string, string | number> = { rvprop };
            if (needsSource && section !== undefined) {
                readParams.rvsection = section;
            }
            const page = await mwn.read(title, readParams);

            if (page.invalid === true) {
                return ctx.format.invalidInput(`"${title}" is not a valid page title`);
            }

            if (page.missing) {
                if (pending !== undefined) {
                    return ctx.format.ok({
                        title,
                        pending,
                        pendingNotice:
                            'The page does not exist yet; the version in pending is awaiting moderation.',
                    });
                }
                return ctx.format.notFound(`Page "${title}" not found`);
            }

            const rev = page.revisions?.[0];

            if (metadata) {
                entries = await ctx.sections.list(mwn, title);
            }

            // 版本号随读取内容的请求一并返回：按节写入时需要它指明所读版本。
            // 若仅在 metadata=true 时返回，常规的读-改-写流程会在写入时失败。
            if (needsSource && rev?.revid !== undefined) {
                payload.latestRevisionId = rev.revid;
            }

            if (metadata || content === ContentFormat.none) {
                payload.pageId = page.pageid;
                payload.title = page.title;
                payload.latestRevisionId = rev?.revid;
                payload.latestRevisionTimestamp = rev?.timestamp;
                payload.contentModel = rev?.contentmodel;
                if (rev?.size !== undefined) {
                    payload.size = rev.size;
                }
                if (entries !== undefined) {
                    payload.sections = toOutlineLines(entries);
                }
                payload.url = await buildPageUrl(ctx, page.title);
            }

            if (needsSource && rev?.content !== undefined) {
                const truncated = truncateByBytes(rev.content);
                payload.source = truncated.text;
                if (truncated.truncated) {
                    entries ??= await ctx.sections.list(mwn, title);
                    payload.truncation = sectionContentTruncation({
                        entries,
                        section,
                        itemNoun: 'wikitext',
                        toolName: 'get-page',
                        returnedBytes: truncated.returnedBytes,
                        totalBytes: truncated.totalBytes,
                    });
                }
            }
        }

        if (content === ContentFormat.html) {
            const parseParams: Record<string, string | number> = {
                action: 'parse',
                page: title,
                prop: 'text',
                formatversion: '2',
            };
            if (section !== undefined) {
                parseParams.section = section;
            }
            const parseResult = await mwn.request(parseParams);
            const html: string | undefined = parseResult.parse?.text;

            if (html !== undefined) {
                const truncated = truncateByBytes(html);
                payload.html = truncated.text;

                if (payload.title === undefined) {
                    const resolvedTitle: string = parseResult.parse?.title ?? title;
                    payload.title = resolvedTitle;
                    if (parseResult.parse?.pageid !== undefined) {
                        payload.pageId = parseResult.parse.pageid;
                    }
                    payload.url = await buildPageUrl(ctx, resolvedTitle);
                }

                if (truncated.truncated) {
                    entries ??= await ctx.sections.list(mwn, title);
                    payload.truncation = sectionContentTruncation({
                        entries,
                        section,
                        itemNoun: 'HTML',
                        toolName: 'get-page',
                        returnedBytes: truncated.returnedBytes,
                        totalBytes: truncated.totalBytes,
                    });
                }
            }
        }

        if (pending !== undefined) {
            payload.pending = pending;
            payload.pendingNotice =
                'This wiki holds a pending version of this page submitted by you that is awaiting moderation; pending.wikitext is that submitted text. The rest of this response reflects the live page.';
        }

        return ctx.format.ok(payload);
    },
};

/**
 * 读取当前账号在页面上的待审版本。
 *
 * includePending 是辅助信息，请求失败时按没有待审版本处理，不让整次读取失败。
 */
const readPending = async (
    ctx: ToolContext,
    mwn: Mwn,
    title: string,
    section: number | undefined,
): Promise<PendingPayload | undefined> => {
    try {
        const pending = await ctx.moderation.pending(mwn, title, section);
        if (pending === undefined) {
            return undefined;
        }
        const truncated = truncateByBytes(pending.wikitext);
        return {
            wikitext: truncated.text,
            ...(pending.comment !== undefined ? { comment: pending.comment } : {}),
            ...(truncated.truncated
                ? {
                      truncation: {
                          returnedBytes: truncated.returnedBytes,
                          totalBytes: truncated.totalBytes,
                      },
                  }
                : {}),
        };
    } catch {
        return undefined;
    }
};

export { getPage };
