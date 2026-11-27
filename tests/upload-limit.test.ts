/**
 * 上传大小预检的单元测试。
 *
 * 覆盖：站点上限的解析与边界判断、本地上传超限时不上传、
 * URL 上传按 min(服务端内存上限, 站点上限) 抓取、站点上限超限时返回
 * invalid_input，以及服务端上限更严时沿用转交 wiki 侧复制上传的既有行为。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiParams } from 'mwn';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/httpFetch.ts', async importOriginal => {
    const actual = await importOriginal<typeof import('../src/httpFetch.ts')>();
    return {
        ...actual,
        fetchFileBytes: vi.fn(),
        // 服务端内存上限固定为 100 MB，避免测试结果受环境变量影响。
        resolveUploadMaxBytes: vi.fn(() => 100 * 1024 * 1024),
    };
});

import { DEFAULT_EDIT_SUMMARY } from '../src/config/editSummary.ts';
import type { WikiConfig } from '../src/config/loadConfig.ts';
import { FileTooLargeError, fetchFileBytes } from '../src/httpFetch.ts';
import { ResponseFormatterImpl } from '../src/results/response.ts';
import type { ToolContext } from '../src/runtime/context.ts';
import type { EditService } from '../src/services/editService.ts';
import { updateFileFromUrl } from '../src/tools/update-file-from-url.ts';
import { updateFile } from '../src/tools/update-file.ts';
import { uploadFileFromUrl } from '../src/tools/upload-file-from-url.ts';
import { uploadFile } from '../src/tools/upload-file.ts';
import type { SiteInfo } from '../src/wikis/siteInfoCache.ts';
import {
    exceedsSiteUploadLimit,
    formatByteSize,
    readMaxUploadSize,
    resolveEffectiveMaxBytes,
    siteUploadLimitMessage,
} from '../src/wikis/uploadLimit.ts';

/** 服务端内存上限，与 httpFetch 的替身一致。 */
const SERVER_MAX_BYTES = 100 * 1024 * 1024;
/** 站点上限，取 BWiki 线上的 8388608。 */
const SITE_MAX_BYTES = 8 * 1024 * 1024;
const UPLOAD_URL = 'https://example.org/big.png';

const fetchFileBytesMock = vi.mocked(fetchFileBytes);

const baseSiteInfo: SiteInfo = {
    server: 'https://wiki.example.org',
    articlepath: '/test',
    namespaceNames: { file: 6, 文件: 6 },
    namespaceCanonical: { 6: 'File' },
};

const withSiteLimit = (maxuploadsize: number): SiteInfo => ({ ...baseSiteInfo, maxuploadsize });

interface CtxOptions {
    siteInfo?: SiteInfo;
    uploadDirs?: readonly string[];
    /** update-*-from-url 的 assertFileExists 响应。 */
    queryPages?: unknown[];
}

/** 记录上传调用的假 ctx；mwn 的记录用于区分服务端上传与 wiki 侧复制上传。 */
const makeCtx = (options: CtxOptions = {}) => {
    const uploadCalls: string[] = [];
    const edit: EditService = {
        submit: async () => ({}),
        submitUpload: async () => {
            uploadCalls.push('submitUpload');
            return { result: 'Success' };
        },
        submitUploadFromBytes: async () => {
            uploadCalls.push('submitUploadFromBytes');
            return { result: 'Success' };
        },
        applyTags: params => params,
        botRight: async () => true,
    };

    const uploadFromUrlCalls: string[] = [];
    const mwn = {
        request: async (_params: ApiParams) => ({ query: { pages: options.queryPages ?? [] } }),
        uploadFromUrl: async (url: string) => {
            uploadFromUrlCalls.push(url);
            return { result: 'Success', filename: 'X.png' };
        },
    };

    const siteInfo = options.siteInfo ?? baseSiteInfo;
    const ctx = {
        mwn: async () => mwn,
        activeWiki: { get: () => ({ key: 'test', config: {} as unknown as WikiConfig }) },
        siteInfoCache: { get: () => siteInfo, isFresh: () => true },
        edit,
        format: new ResponseFormatterImpl(),
        editSummary: DEFAULT_EDIT_SUMMARY,
        uploadDirs: { list: () => options.uploadDirs ?? [] },
    } as unknown as ToolContext;

    return { ctx, uploadCalls, uploadFromUrlCalls };
};

/** 解析错误结果的内容信封。 */
const envelopeOf = (result: { content: unknown[] }): { category: string; message: string } => {
    const first = result.content[0] as { text: string } | undefined;
    return JSON.parse(first?.text ?? '{}') as { category: string; message: string };
};

let workDir = '';

beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'bwiki-upload-limit-test-'));
    // 16 字节，便于用很小的站点上限构造边界。
    await writeFile(join(workDir, 'image.png'), Buffer.alloc(16, 1));
});

afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
});

beforeEach(() => {
    fetchFileBytesMock.mockReset();
});

describe('uploadLimit 纯函数', () => {
    it('只接受有限正整数上限', () => {
        expect(readMaxUploadSize(8388608)).toBe(8388608);
        expect(readMaxUploadSize('8388608')).toBe(8388608);
        expect(readMaxUploadSize(0)).toBeUndefined();
        expect(readMaxUploadSize(-1)).toBeUndefined();
        expect(readMaxUploadSize(1.5)).toBeUndefined();
        expect(readMaxUploadSize(Number.POSITIVE_INFINITY)).toBeUndefined();
        expect(readMaxUploadSize(undefined)).toBeUndefined();
        expect(readMaxUploadSize('abc')).toBeUndefined();
    });

    it('等于上限不算超限，超一字节才算', () => {
        expect(exceedsSiteUploadLimit(SITE_MAX_BYTES, SITE_MAX_BYTES)).toBe(false);
        expect(exceedsSiteUploadLimit(SITE_MAX_BYTES + 1, SITE_MAX_BYTES)).toBe(true);
    });

    it('站点未报告上限时不做预检', () => {
        expect(exceedsSiteUploadLimit(Number.MAX_SAFE_INTEGER, undefined)).toBe(false);
        expect(resolveEffectiveMaxBytes(SERVER_MAX_BYTES, undefined)).toBe(SERVER_MAX_BYTES);
    });

    it('抓取上限取服务端内存上限与站点上限的较小者', () => {
        expect(resolveEffectiveMaxBytes(SERVER_MAX_BYTES, SITE_MAX_BYTES)).toBe(SITE_MAX_BYTES);
        // 服务端上限更小时以服务端为准。
        expect(resolveEffectiveMaxBytes(SITE_MAX_BYTES, SERVER_MAX_BYTES)).toBe(SITE_MAX_BYTES);
    });

    it('字节数格式化覆盖 B/KiB/MiB', () => {
        expect(formatByteSize(512)).toBe('512 B');
        expect(formatByteSize(2048)).toBe('2.0 KiB');
        expect(formatByteSize(SITE_MAX_BYTES)).toBe('8.0 MiB');
    });

    it('错误文案含实际字节数、站点上限与建议', () => {
        const message = siteUploadLimitMessage(SITE_MAX_BYTES + 1, SITE_MAX_BYTES);
        expect(message).toContain(String(SITE_MAX_BYTES + 1));
        expect(message).toContain(String(SITE_MAX_BYTES));
        expect(message).toContain('8.0 MiB');
        expect(message).toMatch(/smaller file/);
    });
});

describe('本地上传的站点上限预检', () => {
    it('upload-file 超限时返回 invalid_input 且不发起上传', async () => {
        const { ctx, uploadCalls } = makeCtx({
            siteInfo: withSiteLimit(8),
            uploadDirs: [workDir],
        });
        const result = await uploadFile.handle(
            { filepath: join(workDir, 'image.png'), title: 'X.png', text: 't' },
            ctx,
        );
        expect(result.isError).toBe(true);
        const envelope = envelopeOf(result);
        expect(envelope.category).toBe('invalid_input');
        expect(envelope.message).toContain('16 bytes');
        expect(envelope.message).toContain('8 bytes');
        expect(uploadCalls).toHaveLength(0);
    });

    it('大小恰等于站点上限时仍上传', async () => {
        const { ctx, uploadCalls } = makeCtx({
            siteInfo: withSiteLimit(16),
            uploadDirs: [workDir],
        });
        const result = await uploadFile.handle(
            { filepath: join(workDir, 'image.png'), title: 'X.png', text: 't' },
            ctx,
        );
        expect(result.isError).toBeUndefined();
        expect(uploadCalls).toEqual(['submitUpload']);
    });

    it('站点未报告上限时不预检', async () => {
        const { ctx, uploadCalls } = makeCtx({ uploadDirs: [workDir] });
        const result = await uploadFile.handle(
            { filepath: join(workDir, 'image.png'), title: 'X.png', text: 't' },
            ctx,
        );
        expect(result.isError).toBeUndefined();
        expect(uploadCalls).toEqual(['submitUpload']);
    });

    it('update-file 同样在读取文件前预检', async () => {
        const { ctx, uploadCalls } = makeCtx({
            siteInfo: withSiteLimit(8),
            uploadDirs: [workDir],
        });
        const result = await updateFile.handle(
            { filepath: join(workDir, 'image.png'), title: 'File:X.png' },
            ctx,
        );
        expect(envelopeOf(result).category).toBe('invalid_input');
        expect(uploadCalls).toHaveLength(0);
    });
});

describe('URL 上传的站点上限预检', () => {
    it('超过站点上限时返回 invalid_input 且不上传', async () => {
        fetchFileBytesMock.mockRejectedValue(
            new FileTooLargeError(SITE_MAX_BYTES + 1, SITE_MAX_BYTES, 'MCP_UPLOAD_MAX_BYTES'),
        );
        const { ctx, uploadCalls, uploadFromUrlCalls } = makeCtx({
            siteInfo: withSiteLimit(SITE_MAX_BYTES),
        });
        const result = await uploadFileFromUrl.handle(
            { url: UPLOAD_URL, title: 'X.png', text: 't' },
            ctx,
        );
        expect(result.isError).toBe(true);
        const envelope = envelopeOf(result);
        expect(envelope.category).toBe('invalid_input');
        expect(envelope.message).toContain(String(SITE_MAX_BYTES));
        expect(envelope.message).toMatch(/smaller file/);
        expect(uploadCalls).toHaveLength(0);
        expect(uploadFromUrlCalls).toHaveLength(0);
        // 抓取上限被压到站点上限，比服务端内存上限更严。
        expect(fetchFileBytesMock).toHaveBeenCalledWith(
            UPLOAD_URL,
            expect.objectContaining({ maxBytes: SITE_MAX_BYTES }),
        );
    });

    it('Content-Length 缺失时按累计字节读取，正常走上传', async () => {
        // 替身返回字节即代表「响应没有声明长度、字节在限内」。
        fetchFileBytesMock.mockResolvedValue(Buffer.from('PNGDATA'));
        const { ctx, uploadCalls } = makeCtx({ siteInfo: withSiteLimit(SITE_MAX_BYTES) });
        const result = await uploadFileFromUrl.handle(
            { url: UPLOAD_URL, title: 'X.png', text: 't' },
            ctx,
        );
        expect(result.isError).toBeUndefined();
        expect(uploadCalls).toEqual(['submitUploadFromBytes']);
    });

    it('服务端内存上限更严格时仍转交 wiki 侧复制上传', async () => {
        fetchFileBytesMock.mockRejectedValue(
            new FileTooLargeError(SERVER_MAX_BYTES + 1, SERVER_MAX_BYTES, 'MCP_UPLOAD_MAX_BYTES'),
        );
        const { ctx, uploadCalls, uploadFromUrlCalls } = makeCtx({
            siteInfo: withSiteLimit(500 * 1024 * 1024),
        });
        const result = await uploadFileFromUrl.handle(
            { url: UPLOAD_URL, title: 'X.png', text: 't' },
            ctx,
        );
        expect(result.isError).toBeUndefined();
        expect(uploadCalls).toHaveLength(0);
        expect(uploadFromUrlCalls).toEqual([UPLOAD_URL]);
        expect(fetchFileBytesMock).toHaveBeenCalledWith(
            UPLOAD_URL,
            expect.objectContaining({ maxBytes: SERVER_MAX_BYTES }),
        );
    });

    it('站点未报告上限时只受服务端内存上限约束', async () => {
        fetchFileBytesMock.mockResolvedValue(Buffer.from('PNGDATA'));
        const { ctx, uploadCalls } = makeCtx();
        const result = await uploadFileFromUrl.handle(
            { url: UPLOAD_URL, title: 'X.png', text: 't' },
            ctx,
        );
        expect(result.isError).toBeUndefined();
        expect(uploadCalls).toEqual(['submitUploadFromBytes']);
        expect(fetchFileBytesMock).toHaveBeenCalledWith(
            UPLOAD_URL,
            expect.objectContaining({ maxBytes: SERVER_MAX_BYTES }),
        );
    });

    it('update-file-from-url 超限时同样返回 invalid_input', async () => {
        fetchFileBytesMock.mockRejectedValue(
            new FileTooLargeError(SITE_MAX_BYTES + 1, SITE_MAX_BYTES, 'MCP_UPLOAD_MAX_BYTES'),
        );
        const { ctx, uploadCalls, uploadFromUrlCalls } = makeCtx({
            siteInfo: withSiteLimit(SITE_MAX_BYTES),
            queryPages: [
                { title: 'File:X.png', imageinfo: [{ timestamp: '2026-01-01T00:00:00Z' }] },
            ],
        });
        const result = await updateFileFromUrl.handle(
            { url: UPLOAD_URL, title: 'File:X.png' },
            ctx,
        );
        expect(envelopeOf(result).category).toBe('invalid_input');
        expect(uploadCalls).toHaveLength(0);
        expect(uploadFromUrlCalls).toHaveLength(0);
    });
});
