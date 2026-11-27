import { stat } from 'node:fs/promises';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ApiUploadResponse } from 'mwn';
import type { ApiUploadParams } from 'types-mediawiki-api';
import { z } from 'zod';
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
    text: z.string().describe('Wikitext on the file page'),
    comment: z.string().optional().describe('Reason for uploading the file'),
} as const;

const uploadFile: Tool<typeof inputSchema> = {
    name: 'upload-file',
    description:
        "Uploads a file from the local disk into the wiki's File namespace and returns the resulting file title and URL. The upload appears in the wiki's upload log. The operator restricts which directories are readable; filepath must be an absolute path inside a configured upload directory, or the call fails before contacting the wiki. Fails if a file with the target title already exists (the wiki does not silently overwrite existing files). To upload directly from a remote web address instead of a local path, use upload-file-from-url. To replace an existing file with a new revision, use update-file.",
    inputSchema,
    annotations: {
        title: 'Upload file',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
    },
    failureVerb: 'upload file',
    target: a => a.title,

    async handle({ filepath, title, text, comment }, ctx: ToolContext): Promise<CallToolResult> {
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
                return ctx.format.invalidInput(`Failed to upload file: ${error.message}`);
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
                    `Failed to upload file: ${siteUploadLimitMessage(size, siteMaxUploadSize)}`,
                );
            }
        }

        const mwn = await ctx.mwn();
        const params: ApiUploadParams = {
            comment: formatEditComment(ctx, 'upload-file', comment),
        };
        // 不发送 ignorewarnings：同名冲突必须报错，而非静默覆盖。
        let data: ApiUploadResponse;
        try {
            data = await ctx.edit.submitUpload(
                mwn,
                resolvedPath,
                resolvedTitle.bareName,
                text,
                params,
            );
        } catch (error) {
            if (error instanceof UploadValidationError) {
                return ctx.format.invalidInput(`Failed to upload file: ${error.message}`);
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

export { uploadFile };
