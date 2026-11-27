import { stat } from 'node:fs/promises';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ApiUploadResponse } from 'mwn';
import type { ApiUploadParams } from 'types-mediawiki-api';
import { z } from 'zod';
import { assertFileExists, FileNotFoundError, InvalidFileTitleError } from '../fileExistence.ts';
import type { ToolContext } from '../runtime/context.ts';
import type { Tool } from '../runtime/tool.ts';
import { assertAllowedPath, UploadValidationError } from '../uploadGuard.ts';
import { resolveSiteInfo } from '../wikis/siteInfo.ts';
import { toNamespaceTitle } from '../wikis/titlePrefix.ts';
import { exceedsSiteUploadLimit, siteUploadLimitMessage } from '../wikis/uploadLimit.ts';
import { formatEditComment, buildPageUrl } from '../wikis/utils.ts';

const inputSchema = {
    filepath: z.string().describe('File path on the local disk'),
    title: z.string().describe('File title (with or without the "File:" prefix)'),
    comment: z.string().optional().describe('Reason for uploading the new revision'),
} as const;

const updateFile: Tool<typeof inputSchema> = {
    name: 'update-file',
    description:
        "Uploads a new revision of an existing file from the local disk, preserving prior revisions in the file history, and returns the file title and URL. The upload appears in the wiki's upload log. Replaces the file content (bytes) only; for editing the wikitext on a file's description page, use update-page. The operator restricts which directories are readable; filepath must be an absolute path inside a configured upload directory, or the call fails before contacting the wiki. Fails if no file exists at the target title; for the initial upload, use upload-file. To upload a new revision from a remote web address instead of a local path, use update-file-from-url.",
    inputSchema,
    annotations: {
        title: 'Update file',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
    },
    failureVerb: 'update file',
    target: a => a.title,

    async handle({ filepath, title, comment }, ctx: ToolContext): Promise<CallToolResult> {
        const siteInfo = await resolveSiteInfo(ctx, ctx.activeWiki.get().key);
        const resolvedTitle = toNamespaceTitle(title, 6, siteInfo);
        if ('error' in resolvedTitle) {
            return ctx.format.invalidInput(resolvedTitle.error);
        }

        let resolvedPath: string;
        try {
            resolvedPath = await assertAllowedPath(filepath, ctx.uploadDirs.list());
        } catch (error) {
            if (error instanceof UploadValidationError) {
                return ctx.format.invalidInput(`Failed to update file: ${error.message}`);
            }
            throw error;
        }

        // 站点上限小于服务端内存上限时，本地文件也可能被拒：
        // 先 stat 拿到大小，超限就不必读取整份文件、也不发出上传请求。
        const siteMaxUploadSize = siteInfo.maxuploadsize;
        if (siteMaxUploadSize !== undefined) {
            const { size } = await stat(resolvedPath);
            if (exceedsSiteUploadLimit(size, siteMaxUploadSize)) {
                return ctx.format.invalidInput(
                    `Failed to update file: ${siteUploadLimitMessage(size, siteMaxUploadSize)}`,
                );
            }
        }

        const mwn = await ctx.mwn();
        try {
            await assertFileExists(mwn, title, siteInfo);
        } catch (error) {
            if (error instanceof InvalidFileTitleError) {
                return ctx.format.invalidInput(error.message);
            }
            if (error instanceof FileNotFoundError) {
                return ctx.format.notFound(
                    `File "${error.title}" does not exist. To create a new file, use upload-file.`,
                );
            }
            throw error;
        }

        const params: ApiUploadParams = {
            comment: formatEditComment(ctx, 'update-file', comment),
            // 覆盖已有文件必须带 ignorewarnings；同时不发送 text，保留文件页原有文本。
            ignorewarnings: true,
        };
        let data: ApiUploadResponse;
        try {
            data = await ctx.edit.submitUpload(
                mwn,
                resolvedPath,
                resolvedTitle.bareName,
                undefined,
                params,
            );
        } catch (error) {
            if (error instanceof UploadValidationError) {
                return ctx.format.invalidInput(`Failed to update file: ${error.message}`);
            }
            throw error;
        }

        const imageinfo = (
            data as ApiUploadResponse & {
                imageinfo?: { descriptionurl?: string; url?: string };
            }
        ).imageinfo;
        const filename = data.filename ?? resolvedTitle.bareName;
        return ctx.format.ok({
            filename,
            pageUrl: imageinfo?.descriptionurl ?? (await buildPageUrl(ctx, `File:${filename}`)),
            ...(imageinfo?.url !== undefined ? { fileUrl: imageinfo.url } : {}),
        });
    },
};

export { updateFile };
