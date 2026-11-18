/**
 * 上传路径守卫与上传工具的单元测试。
 *
 * 覆盖：目录白名单校验（相对路径、越界、不存在、非普通文件），以及
 * upload-file/update-file 传入 wiki 的参数（裸文件名、不发送 ignorewarnings、
 * update 省略 text）。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiUploadResponse } from 'mwn';
import type { ApiUploadParams } from 'types-mediawiki-api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_EDIT_SUMMARY } from '../src/config/editSummary.ts';
import type { WikiConfig } from '../src/config/loadConfig.ts';
import { ResponseFormatterImpl } from '../src/results/response.ts';
import type { ToolContext } from '../src/runtime/context.ts';
import type { EditService } from '../src/services/editService.ts';
import { updateFile } from '../src/tools/update-file.ts';
import { uploadFile } from '../src/tools/upload-file.ts';
import { assertAllowedPath, UploadValidationError } from '../src/uploadGuard.ts';
import type { SiteInfo } from '../src/wikis/siteInfoCache.ts';

const siteInfo: SiteInfo = {
    server: 'https://wiki.example.org',
    articlepath: '/test',
    sitename: 'Test Wiki',
    namespaceNames: { file: 6, 文件: 6, category: 14 },
    namespaceCanonical: { 6: 'File', 14: 'Category' },
};

interface UploadCall {
    filepath: string;
    title: string;
    text: string | undefined;
    params: ApiUploadParams;
}

interface CtxOptions {
    uploadDirs?: readonly string[];
    /** upload 的返回结果；默认 Success。 */
    uploadResult?: ApiUploadResponse;
    /** update-file 的 assertFileExists 响应。 */
    queryPages?: unknown[];
}

const makeCtx = (options: CtxOptions = {}) => {
    const uploads: UploadCall[] = [];
    const edit: EditService = {
        submit: async () => ({}),
        submitUpload: async (
            _mwn,
            filepath: string,
            title: string,
            text: string | undefined,
            params: ApiUploadParams,
        ): Promise<ApiUploadResponse> => {
            uploads.push({ filepath, title, text, params });
            return options.uploadResult ?? { result: 'Success' };
        },
        submitUploadFromBytes: async () => {
            throw new Error('submitUploadFromBytes should not be called');
        },
        applyTags: options => options,
        botRight: async () => true,
    };

    const mwn = {
        request: async () => ({ query: { pages: options.queryPages ?? [] } }),
        rawRequest: async () => ({}),
        uploadFromUrl: async () => ({}),
        usingOAuth2: false,
        options: {},
    };

    const ctx = {
        mwn: async () => mwn,
        activeWiki: {
            get: () => ({ key: 'test', config: {} as unknown as WikiConfig }),
        },
        siteInfoCache: {
            get: () => siteInfo,
            isFresh: () => true,
        },
        edit,
        format: new ResponseFormatterImpl(),
        editSummary: DEFAULT_EDIT_SUMMARY,
        uploadDirs: { list: () => options.uploadDirs ?? [] },
    } as unknown as ToolContext;

    return { ctx, uploads };
};

/** 解析错误结果的内容信封。 */
const envelopeOf = (result: { content: unknown[] }): { category: string; message: string } => {
    const first = result.content[0] as { text: string } | undefined;
    return JSON.parse(first?.text ?? '{}') as { category: string; message: string };
};

let workDir = '';

beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'bwiki-upload-guard-test-'));
    await writeFile(join(workDir, 'image.png'), Buffer.from('PNGDATA'));
});

afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
});

describe('assertAllowedPath', () => {
    it('未配置上传目录时拒绝', async () => {
        await expect(assertAllowedPath(join(workDir, 'image.png'), [])).rejects.toThrow(
            UploadValidationError,
        );
        await expect(assertAllowedPath(join(workDir, 'image.png'), [])).rejects.toThrow(
            /uploads are disabled/,
        );
    });

    it('相对路径被拒绝', async () => {
        await expect(assertAllowedPath('image.png', [workDir])).rejects.toThrow(
            /provide an absolute path/,
        );
    });

    it('不存在的文件被拒绝', async () => {
        await expect(assertAllowedPath(join(workDir, 'nope.png'), [workDir])).rejects.toThrow(
            UploadValidationError,
        );
    });

    it('目录白名单外的路径被拒绝', async () => {
        const otherDir = join(tmpdir(), 'bwiki-not-an-allowed-dir');
        await expect(assertAllowedPath(join(workDir, 'image.png'), [otherDir])).rejects.toThrow(
            /outside the allowed upload directories/,
        );
    });

    it('白名单内的路径通过并返回真实路径', async () => {
        const resolved = await assertAllowedPath(join(workDir, 'image.png'), [workDir]);
        expect(resolved.endsWith('image.png')).toBe(true);
    });
});

describe('upload-file', () => {
    it('传裸文件名且不发送 ignorewarnings', async () => {
        const { ctx, uploads } = makeCtx({ uploadDirs: [workDir] });
        const result = await uploadFile.handle(
            { filepath: join(workDir, 'image.png'), title: 'X.png', text: 'file page' },
            ctx,
        );
        expect(result.isError).toBeUndefined();
        expect(uploads).toHaveLength(1);
        expect(uploads[0]?.title).toBe('X.png');
        expect(uploads[0]?.text).toBe('file page');
        expect(Object.hasOwn(uploads[0]?.params ?? {}, 'ignorewarnings')).toBe(false);
        expect(result.structuredContent).toEqual({
            filename: 'X.png',
            pageUrl: 'https://wiki.example.org/test/File:X.png',
        });
    });

    it('File: 前缀被去掉后传给服务', async () => {
        const { ctx, uploads } = makeCtx({ uploadDirs: [workDir] });
        await uploadFile.handle(
            { filepath: join(workDir, 'image.png'), title: 'File:X.png', text: 't' },
            ctx,
        );
        expect(uploads[0]?.title).toBe('X.png');
    });

    it('本地化前缀被识别', async () => {
        const { ctx, uploads } = makeCtx({ uploadDirs: [workDir] });
        await uploadFile.handle(
            { filepath: join(workDir, 'image.png'), title: '文件:X.png', text: 't' },
            ctx,
        );
        expect(uploads[0]?.title).toBe('X.png');
    });

    it('跨命名空间标题返回 invalid_input', async () => {
        const { ctx, uploads } = makeCtx({ uploadDirs: [workDir] });
        const result = await uploadFile.handle(
            { filepath: join(workDir, 'image.png'), title: 'Category:X', text: 't' },
            ctx,
        );
        expect(result.isError).toBe(true);
        expect(envelopeOf(result).category).toBe('invalid_input');
        expect(uploads).toHaveLength(0);
    });

    it('路径越界返回 invalid_input', async () => {
        const { ctx } = makeCtx({ uploadDirs: [join(tmpdir(), 'bwiki-not-an-allowed-dir')] });
        const result = await uploadFile.handle(
            { filepath: join(workDir, 'image.png'), title: 'X.png', text: 't' },
            ctx,
        );
        expect(result.isError).toBe(true);
        expect(envelopeOf(result).category).toBe('invalid_input');
    });

    it('服务端判定非普通文件时返回 invalid_input', async () => {
        const { ctx } = makeCtx({ uploadDirs: [workDir] });
        // 模拟 editService 在读取时抛出的校验错误。
        Object.assign(ctx.edit, {
            submitUpload: async () => {
                throw new UploadValidationError('not a regular file');
            },
        });
        const result = await uploadFile.handle(
            { filepath: join(workDir, 'image.png'), title: 'X.png', text: 't' },
            ctx,
        );
        expect(result.isError).toBe(true);
        expect(envelopeOf(result).category).toBe('invalid_input');
    });

    it('使用 imageinfo 的 descriptionurl 作为页面链接', async () => {
        const { ctx } = makeCtx({
            uploadDirs: [workDir],
            uploadResult: {
                result: 'Success',
                filename: 'X.png',
                imageinfo: { descriptionurl: 'https://wiki.example.org/wiki/File:X.png' },
            },
        });
        const result = await uploadFile.handle(
            { filepath: join(workDir, 'image.png'), title: 'X.png', text: 't' },
            ctx,
        );
        expect(result.structuredContent).toMatchObject({
            pageUrl: 'https://wiki.example.org/wiki/File:X.png',
        });
    });
});

describe('update-file', () => {
    it('保留 ignorewarnings 且省略 text', async () => {
        const { ctx, uploads } = makeCtx({
            uploadDirs: [workDir],
            queryPages: [
                { title: 'File:X.png', imageinfo: [{ timestamp: '2026-01-01T00:00:00Z' }] },
            ],
        });
        const result = await updateFile.handle(
            { filepath: join(workDir, 'image.png'), title: 'File:X.png' },
            ctx,
        );
        expect(result.isError).toBeUndefined();
        expect(uploads[0]?.title).toBe('X.png');
        expect(uploads[0]?.text).toBeUndefined();
        expect(uploads[0]?.params.ignorewarnings).toBe(true);
    });

    it('文件不存在返回 not_found', async () => {
        const { ctx } = makeCtx({
            uploadDirs: [workDir],
            queryPages: [{ title: 'File:X.png', missing: true }],
        });
        const result = await updateFile.handle(
            { filepath: join(workDir, 'image.png'), title: 'X.png' },
            ctx,
        );
        expect(envelopeOf(result).category).toBe('not_found');
    });

    it('非法标题返回 invalid_input 而非 not_found', async () => {
        const { ctx } = makeCtx({
            uploadDirs: [workDir],
            queryPages: [{ title: 'File:X.png', invalid: true, missing: true }],
        });
        const result = await updateFile.handle(
            { filepath: join(workDir, 'image.png'), title: 'X.png' },
            ctx,
        );
        expect(envelopeOf(result).category).toBe('invalid_input');
    });
});
