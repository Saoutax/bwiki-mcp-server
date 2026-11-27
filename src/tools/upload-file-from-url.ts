import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ApiUploadResponse } from 'mwn';
import type { ApiUploadParams } from 'types-mediawiki-api';
import { z } from 'zod';
import { errorMessage } from '../errors/isErrnoException.ts';
import {
    fetchFileBytes,
    FileTooLargeError,
    resolveUploadMaxBytes,
    shouldRescueToWiki,
} from '../httpFetch.ts';
import type { ToolContext } from '../runtime/context.ts';
import { getRequestSignal } from '../runtime/requestContext.ts';
import type { Tool } from '../runtime/tool.ts';
import { assertUploadResult } from '../services/editService.ts';
import { resolveSiteInfo } from '../wikis/siteInfo.ts';
import { toNamespaceTitle } from '../wikis/titlePrefix.ts';
import { resolveEffectiveMaxBytes, siteUploadLimitMessage } from '../wikis/uploadLimit.ts';
import { formatEditComment, buildPageUrl } from '../wikis/utils.ts';

const inputSchema = {
    url: z.string().url().describe('URL of the file to upload'),
    title: z.string().describe('File title (with or without the "File:" prefix)'),
    text: z.string().describe('Wikitext on the file page'),
    comment: z.string().optional().describe('Reason for uploading the file'),
} as const;

const uploadFileFromUrl: Tool<typeof inputSchema> = {
    name: 'upload-file-from-url',
    description:
        "Fetches a file from a remote web URL and uploads it into the wiki's File namespace, returning the resulting file title and URL. The upload appears in the wiki's upload log. Works whether or not the wiki has upload-by-URL enabled: the server retrieves the file and uploads it directly, falling back to wiki-side fetching only when it cannot reach the URL itself. Fails if a file with the target title already exists. To replace an existing file with a new revision, use update-file-from-url.",
    inputSchema,
    annotations: {
        title: 'Upload file from URL',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
    },
    failureVerb: 'upload file',
    target: a => a.title,

    async handle({ url, title, text, comment }, ctx: ToolContext): Promise<CallToolResult> {
        const siteInfo = await resolveSiteInfo(ctx, ctx.activeWiki.get().key);
        const resolvedTitle = toNamespaceTitle(title, 6, siteInfo);
        if ('error' in resolvedTitle) {
            return ctx.format.invalidInput(resolvedTitle.error);
        }
        const bareName = resolvedTitle.bareName;

        const mwn = await ctx.mwn();
        const baseParams: ApiUploadParams = {
            comment: formatEditComment(ctx, 'upload-file-from-url', comment),
        };

        // 优先在服务端抓取后以 multipart 上传，wiki 无需开启 copy-upload。
        // 不发送 ignorewarnings：同名冲突必须报错，而非静默覆盖。
        // 抓取上限取服务端内存上限与站点上限的较小者：
        // 站点上限更严时不必读取整份文件就能拒绝。
        const siteMaxUploadSize = siteInfo.maxuploadsize;
        const effectiveMaxBytes = resolveEffectiveMaxBytes(
            resolveUploadMaxBytes(),
            siteMaxUploadSize,
        );
        let bytes: Buffer | undefined;
        try {
            bytes = await fetchFileBytes(url, {
                maxBytes: effectiveMaxBytes,
                signal: getRequestSignal(),
            });
        } catch (error) {
            // 站点上限更严时，转交 wiki 侧只会得到同样的拒绝，直接判定无效输入。
            if (
                error instanceof FileTooLargeError &&
                siteMaxUploadSize !== undefined &&
                error.size > siteMaxUploadSize
            ) {
                return ctx.format.invalidInput(
                    `Could not upload ${url}: ${siteUploadLimitMessage(error.size, siteMaxUploadSize)}`,
                );
            }
            if (!shouldRescueToWiki(error, getRequestSignal())) {
                throw error;
            }
            // 不可达，或仅超出服务端内存上限（未超站点上限）时回退到 wiki 侧 copy-upload。
        }

        let data: ApiUploadResponse;
        if (bytes !== undefined) {
            data = await ctx.edit.submitUploadFromBytes(
                mwn,
                bytes,
                bareName,
                bareName,
                text,
                baseParams,
            );
        } else {
            // mwn.uploadFromUrl 在展开 options 之前硬编码 ignorewarnings: true，
            // 必须显式传 false 才能让同名冲突成为错误而非静默覆盖。
            const params = ctx.edit.applyTags<ApiUploadParams>({
                ...baseParams,
                ignorewarnings: false,
            });
            try {
                data = await mwn.uploadFromUrl(url, bareName, text, params);
            } catch (error) {
                const errorText = errorMessage(error);
                if (errorText.includes('copyuploaddisabled')) {
                    return ctx.format.error(
                        'upstream_failure',
                        `Could not retrieve the file from ${url}: the server could not reach it and the wiki has upload-by-URL disabled.`,
                        'copyuploaddisabled',
                    );
                }
                throw error;
            }
            // mwn 把 warnings 只写入日志，不当作失败；这里统一按 Success 判定。
            assertUploadResult(data);
        }

        const imageinfo = (
            data as ApiUploadResponse & {
                imageinfo?: { descriptionurl?: string; url?: string };
            }
        ).imageinfo;
        const filename = data.filename ?? bareName;
        return ctx.format.ok({
            filename,
            pageUrl: imageinfo?.descriptionurl ?? (await buildPageUrl(ctx, `File:${filename}`)),
            ...(imageinfo?.url !== undefined ? { fileUrl: imageinfo.url } : {}),
        });
    },
};

export { uploadFileFromUrl };
