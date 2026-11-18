import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ApiUploadResponse } from 'mwn';
import type { ApiUploadParams } from 'types-mediawiki-api';
import { z } from 'zod';
import { errorMessage } from '../errors/isErrnoException.ts';
import { assertFileExists, FileNotFoundError, InvalidFileTitleError } from '../fileExistence.ts';
import { fetchFileBytes, shouldRescueToWiki } from '../httpFetch.ts';
import type { ToolContext } from '../runtime/context.ts';
import { getRequestSignal } from '../runtime/requestContext.ts';
import type { Tool } from '../runtime/tool.ts';
import { assertUploadResult } from '../services/editService.ts';
import { resolveSiteInfo } from '../wikis/siteInfo.ts';
import { toNamespaceTitle } from '../wikis/titlePrefix.ts';
import { formatEditComment, buildPageUrl } from '../wikis/utils.ts';

/**
 * mwn.uploadFromUrl 把 text 定为 string，但参数为 undefined 时其 preprocessParams
 * 会删除该字段；传 '' 则会写入空的文件页文本。故显式传 undefined。
 */
const OMITTED_TEXT = undefined as unknown as string;

const inputSchema = {
    url: z.string().url().describe('URL of the file to upload'),
    title: z.string().describe('File title (with or without the "File:" prefix)'),
    comment: z.string().optional().describe('Reason for uploading the new revision'),
} as const;

const updateFileFromUrl: Tool<typeof inputSchema> = {
    name: 'update-file-from-url',
    description:
        "Fetches a file from a remote web URL and uploads it as a new revision of an existing file, preserving prior revisions in the file history, and returns the file title and URL. The upload appears in the wiki's upload log. Replaces the file content (bytes) only; for editing the wikitext on a file's description page, use update-page. Works whether or not the wiki has upload-by-URL enabled: the server retrieves the file and uploads it directly, falling back to wiki-side fetching only when it cannot reach the URL itself. Fails if no file exists at the target title; for the initial upload, use upload-file-from-url.",
    inputSchema,
    annotations: {
        title: 'Update file from URL',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
    },
    failureVerb: 'update file',
    target: a => a.title,

    async handle({ url, title, comment }, ctx: ToolContext): Promise<CallToolResult> {
        const siteInfo = await resolveSiteInfo(ctx, ctx.activeWiki.get().key);
        const resolvedTitle = toNamespaceTitle(title, 6, siteInfo);
        if ('error' in resolvedTitle) {
            return ctx.format.invalidInput(resolvedTitle.error);
        }
        const bareName = resolvedTitle.bareName;

        const mwn = await ctx.mwn();
        try {
            await assertFileExists(mwn, title, siteInfo);
        } catch (error) {
            if (error instanceof InvalidFileTitleError) {
                return ctx.format.invalidInput(error.message);
            }
            if (error instanceof FileNotFoundError) {
                return ctx.format.notFound(
                    `File "${error.title}" does not exist. To create a new file, use upload-file-from-url.`,
                );
            }
            throw error;
        }

        const baseParams: ApiUploadParams = {
            comment: formatEditComment(ctx, 'update-file-from-url', comment),
            // 覆盖已有文件必须带 ignorewarnings。
            ignorewarnings: true,
        };

        // 优先在服务端抓取（经 SSRF 校验、受大小限制）后以 multipart 上传；
        // 仅在无法访问该 URL 时回退到 wiki 侧抓取。
        let bytes: Buffer | undefined;
        try {
            bytes = await fetchFileBytes(url, { signal: getRequestSignal() });
        } catch (error) {
            if (!shouldRescueToWiki(error, getRequestSignal())) {
                throw error;
            }
        }

        let data: ApiUploadResponse;
        if (bytes !== undefined) {
            data = await ctx.edit.submitUploadFromBytes(
                mwn,
                bytes,
                bareName,
                bareName,
                undefined,
                baseParams,
            );
        } else {
            // mwn.uploadFromUrl 在展开 options 之前硬编码 ignorewarnings: true，
            // 这里保留它（更新已存在文件需要覆盖警告）并显式声明，避免依赖 mwn 的默认值。
            const params = ctx.edit.applyTags<ApiUploadParams>({
                ...baseParams,
                ignorewarnings: true,
            });
            try {
                data = await mwn.uploadFromUrl(url, bareName, OMITTED_TEXT, params);
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

export { updateFileFromUrl };
