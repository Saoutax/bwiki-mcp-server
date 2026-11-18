import type { CallToolResult, ImageContent, TextContent } from '@modelcontextprotocol/server';
import type { ApiPage, ImageInfo } from 'mwn';
import { z } from 'zod';
import { fetchGuardedBytes, FileTooLargeError } from '../httpFetch.ts';
import type { ToolContext } from '../runtime/context.ts';
import { getRequestSignal } from '../runtime/requestContext.ts';
import type { Tool } from '../runtime/tool.ts';
import { resolveSiteInfo } from '../wikis/siteInfo.ts';
import { toNamespaceTitle } from '../wikis/titlePrefix.ts';

const DEFAULT_IMAGE_WIDTH = 1024;
const DEFAULT_TEXT_WIDTH = 512;
const MAX_WIDTH = 1568;
const DEFAULT_FILE_DATA_MAX_BYTES = 1_000_000;

// base64 载荷的硬上限。与 MCP_CONTENT_MAX_BYTES 不同，二进制无法截断，超限直接报错。
const resolveFileDataMaxBytes = (): number => {
    const raw = process.env.MCP_FILE_DATA_MAX_BYTES;
    if (raw === undefined || raw === '') {
        return DEFAULT_FILE_DATA_MAX_BYTES;
    }
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return DEFAULT_FILE_DATA_MAX_BYTES;
    }
    return parsed;
};

const inputSchema = {
    title: z.string().describe('File title (with or without the "File:" prefix)'),
    width: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
            'Pixel width of the scaled rendition. A quality/detail knob: in image mode the model caps image tokens regardless of size, so larger mainly means more detail. Defaults to 1024 (512 when format is "text"); values above 1568 are clamped.',
        ),
    format: z
        .enum(['image', 'text'])
        .default('image')
        .describe(
            "'image' returns a native image content block the model can view; 'text' returns the base64 as a text block, for hosts that do not forward image content to the model (base64 text costs far more tokens).",
        ),
} as const;

const getFileData: Tool<typeof inputSchema> = {
    name: 'get-file-data',
    description:
        'Fetches a wiki file server-side and returns the image inline as a content block, for clients that cannot reach the wiki host (sandboxed or network-restricted) and need the image sent to the model for visual analysis. Returns a scaled rendition sized by width. Files MediaWiki can rasterize (images, SVG, PDF, DjVu) come back as an image; other types (audio, video, arbitrary binaries) error — for those, and for metadata or a download URL, use get-file.',
    inputSchema,
    annotations: {
        title: 'Get file data',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
    },
    failureVerb: 'fetch the file image',
    target: a => a.title,

    async handle({ title, width, format }, ctx: ToolContext): Promise<CallToolResult> {
        const siteInfo = await resolveSiteInfo(ctx, ctx.activeWiki.get().key);
        const resolvedTitle = toNamespaceTitle(title, 6, siteInfo);
        if ('error' in resolvedTitle) {
            return ctx.format.invalidInput(resolvedTitle.error);
        }

        const mwn = await ctx.mwn();
        const effectiveWidth = Math.min(
            width ?? (format === 'text' ? DEFAULT_TEXT_WIDTH : DEFAULT_IMAGE_WIDTH),
            MAX_WIDTH,
        );

        const response = await mwn.request({
            action: 'query',
            titles: resolvedTitle.pageTitle,
            prop: 'imageinfo',
            iiprop: 'url|size|mime',
            iiurlwidth: effectiveWidth,
            formatversion: '2',
        });

        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
        const page = response.query?.pages?.[0] as ApiPage | undefined;
        // invalid 必须早于 missing 判断：MediaWiki 对非法标题同时置两个标记。
        if (page?.invalid === true) {
            return ctx.format.invalidInput(`"${title}" is not a valid page title`);
        }
        if (!page || page.missing) {
            return ctx.format.notFound(`File "${title}" not found`);
        }

        const info: ImageInfo | undefined = page.imageinfo?.[0];
        if (!info) {
            return ctx.format.notFound(`No file info available for "${title}"`);
        }

        // 有 thumburl 说明 wiki 已完成栅格化；否则仅原图可直接取。
        const thumb = info as ImageInfo & {
            thumburl?: string;
            thumbwidth?: number;
            thumbheight?: number;
        };
        const isImageMime = typeof info.mime === 'string' && info.mime.startsWith('image/');
        let fetchUrl: string | undefined;
        if (typeof thumb.thumburl === 'string' && thumb.thumburl !== '') {
            fetchUrl = thumb.thumburl;
        } else if (isImageMime) {
            fetchUrl = info.url;
        }
        if (fetchUrl === undefined) {
            return ctx.format.invalidInput(
                `File "${title}" (${info.mime ?? 'unknown type'}) cannot be rendered as an image. Use get-file for its download URL.`,
            );
        }

        // 经 fetchGuardedBytes 下载：逐跳校验 https 与公开地址（取自站点 imageinfo 的
        // URL 同样要过 SSRF 关），并受超时与字节上限约束。
        //
        // 该通道不经 mwn 的认证注入，故手动加 bearer，
        // 且仅在同源时添加，避免泄露到其他主机。
        const fetchHeaders: Record<string, string> = {};
        if (
            mwn.usingOAuth2 &&
            typeof mwn.options.OAuth2AccessToken === 'string' &&
            typeof mwn.options.apiUrl === 'string'
        ) {
            try {
                if (new URL(fetchUrl).origin === new URL(mwn.options.apiUrl).origin) {
                    fetchHeaders.Authorization = `Bearer ${mwn.options.OAuth2AccessToken}`;
                }
            } catch {
                // URL 无法解析，跳过 bearer 注入。
            }
        }

        const maxBytes = resolveFileDataMaxBytes();
        // base64 编码后的长度为原始字节的 4/3，故原始字节上限按编码上限换算；
        // 超限在读取阶段即中止，不会先把整份文件读进内存。
        const rawMaxBytes = Math.max(1, Math.floor((maxBytes * 3) / 4));
        let fetched: { bytes: Buffer; contentType?: string };
        try {
            fetched = await fetchGuardedBytes(fetchUrl, {
                maxBytes: rawMaxBytes,
                headers: fetchHeaders,
                signal: getRequestSignal(),
                limitName: 'MCP_FILE_DATA_MAX_BYTES',
            });
        } catch (error) {
            if (error instanceof FileTooLargeError) {
                return ctx.format.invalidInput(
                    `File data is over the ${maxBytes}-byte encoded limit (MCP_FILE_DATA_MAX_BYTES). Request a smaller width.`,
                );
            }
            throw error;
        }

        // 确认取得的字节确实是图片后再输出 image 块。
        const mimeType =
            fetched.contentType !== undefined && fetched.contentType.startsWith('image/')
                ? fetched.contentType
                : isImageMime
                  ? info.mime
                  : undefined;
        if (mimeType === undefined) {
            return ctx.format.invalidInput(
                `Fetched data for "${title}" is not an image (${fetched.contentType ?? info.mime ?? 'unknown type'}). Use get-file for its download URL.`,
            );
        }

        const base64 = fetched.bytes.toString('base64');
        if (base64.length > maxBytes) {
            return ctx.format.invalidInput(
                `Encoded file data is ${base64.length} bytes, over the ${maxBytes}-byte limit (MCP_FILE_DATA_MAX_BYTES). Request a smaller width.`,
            );
        }

        const wikiKey = ctx.activeWiki.get().key;
        const renderedWidth = thumb.thumbwidth ?? info.width;
        const renderedHeight = thumb.thumbheight ?? info.height;
        const dims =
            renderedWidth !== undefined && renderedHeight !== undefined
                ? `${renderedWidth}×${renderedHeight}`
                : 'unknown size';
        const sizeKb = Math.max(1, Math.round(base64.length / 1024));
        const caption: TextContent = {
            type: 'text',
            text: `File: ${page.title} • Wiki: ${wikiKey} • Type: ${mimeType} • Returned ${dims}, ${sizeKb} KB encoded`,
        };
        const payload: ImageContent | TextContent =
            format === 'text'
                ? { type: 'text', text: base64 }
                : { type: 'image', data: base64, mimeType };

        // 不用 structuredContent：会让 dispatcher 丢掉 image 块。
        return { content: [caption, payload] };
    },
};

export { getFileData };
