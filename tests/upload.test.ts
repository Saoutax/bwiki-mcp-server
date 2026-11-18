/**
 * 编辑服务中上传逻辑的单元测试。
 *
 * 覆盖：text 可选（undefined 不发送）、ignorewarnings 由调用方决定、
 * payload/token 不可被 params 覆盖、上传结果判定，以及本地文件的普通文件校验。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Mwn } from 'mwn';
import type { ApiUploadParams } from 'types-mediawiki-api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    assertUploadResult,
    EditServiceImpl,
    UploadWarningError,
} from '../src/services/editService.ts';
import { UploadValidationError } from '../src/uploadGuard.ts';

interface RecordedRequest {
    params: Record<string, unknown>;
    options: unknown;
}

/** mwn 的替身：记录请求参数并返回预设的 upload 结果。 */
const makeMwn = (upload: unknown = { result: 'Success', filename: 'X.png' }) => {
    const requests: RecordedRequest[] = [];
    const mwn = {
        getCsrfToken: async () => 'csrf-token',
        request: async (params: unknown, options?: unknown) => {
            requests.push({ params: params as Record<string, unknown>, options });
            return { upload };
        },
    } as unknown as Mwn;
    return { mwn, requests };
};

/** 断言 assertUploadResult 抛出带指定错误码的 UploadWarningError。 */
const captureWarning = (upload: unknown): UploadWarningError => {
    try {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test fixture mimics the API response shape
        assertUploadResult(upload as Parameters<typeof assertUploadResult>[0]);
    } catch (error) {
        if (error instanceof UploadWarningError) {
            return error;
        }
        throw error;
    }
    throw new Error('expected assertUploadResult to throw');
};

let workDir = '';

beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'bwiki-upload-test-'));
    await writeFile(join(workDir, 'image.png'), Buffer.from('PNGDATA'));
    await mkdir(join(workDir, 'subdir'));
});

afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
});

describe('submitUploadFromBytes 参数组装', () => {
    it('默认不发送 ignorewarnings', async () => {
        const { mwn, requests } = makeMwn();
        await new EditServiceImpl([]).submitUploadFromBytes(
            mwn,
            Buffer.from('abc'),
            'x.png',
            'File:X.png',
            'text',
            { comment: 'c' },
        );
        expect(Object.hasOwn(requests[0]?.params ?? {}, 'ignorewarnings')).toBe(false);
    });

    it('text 为 undefined 时不带 text 参数', async () => {
        const { mwn, requests } = makeMwn();
        await new EditServiceImpl([]).submitUploadFromBytes(
            mwn,
            Buffer.from('abc'),
            'x.png',
            'File:X.png',
            undefined,
            {},
        );
        expect(Object.hasOwn(requests[0]?.params ?? {}, 'text')).toBe(false);
    });

    it('text 有值时原样发送', async () => {
        const { mwn, requests } = makeMwn();
        await new EditServiceImpl([]).submitUploadFromBytes(
            mwn,
            Buffer.from('abc'),
            'x.png',
            'File:X.png',
            'page text',
            {},
        );
        expect(requests[0]?.params.text).toBe('page text');
    });

    it('params 不能覆盖 action/file/filename/token', async () => {
        const { mwn, requests } = makeMwn();
        const data = Buffer.from('abc');
        // 故意传入与真实类型不符的覆盖值，验证服务端字段优先级。
        const overrides = {
            action: 'delete',
            file: 'evil',
            filename: 'Evil.png',
            token: 'evil-token',
            comment: 'c',
        } as unknown as ApiUploadParams;
        await new EditServiceImpl([]).submitUploadFromBytes(
            mwn,
            data,
            'x.png',
            'File:X.png',
            't',
            overrides,
        );
        const sent = requests[0]?.params ?? {};
        expect(sent.action).toBe('upload');
        expect(sent.filename).toBe('File:X.png');
        expect(sent.token).toBe('csrf-token');
        expect(sent.file).toEqual({ stream: data, name: 'x.png' });
        // 调用方自己的普通参数仍要保留。
        expect(sent.comment).toBe('c');
    });

    it('caller 显式传 ignorewarnings 时保留（update 需要覆盖警告）', async () => {
        const { mwn, requests } = makeMwn();
        await new EditServiceImpl([]).submitUploadFromBytes(
            mwn,
            Buffer.from('abc'),
            'x.png',
            'File:X.png',
            undefined,
            { ignorewarnings: true },
        );
        expect(requests[0]?.params.ignorewarnings).toBe(true);
    });

    it('注入全局标签', async () => {
        const { mwn, requests } = makeMwn();
        await new EditServiceImpl(['bwiki-mcp']).submitUploadFromBytes(
            mwn,
            Buffer.from('abc'),
            'x.png',
            'File:X.png',
            undefined,
            {},
        );
        expect(requests[0]?.params.tags).toEqual(['bwiki-mcp']);
    });

    it('无标签时不发送 tags', async () => {
        const { mwn, requests } = makeMwn();
        await new EditServiceImpl([]).submitUploadFromBytes(
            mwn,
            Buffer.from('abc'),
            'x.png',
            'File:X.png',
            undefined,
            {},
        );
        expect(Object.hasOwn(requests[0]?.params ?? {}, 'tags')).toBe(false);
    });

    it('multipart 请求头', async () => {
        const { mwn, requests } = makeMwn();
        await new EditServiceImpl([]).submitUploadFromBytes(
            mwn,
            Buffer.from('abc'),
            'x.png',
            'File:X.png',
            undefined,
            {},
        );
        expect(requests[0]?.options).toEqual({
            headers: { 'Content-Type': 'multipart/form-data' },
        });
    });

    it('服务端路径同样校验 upload 结果', async () => {
        const { mwn } = makeMwn({ result: 'Warning', warnings: { fileexists: '' } });
        await expect(
            new EditServiceImpl([]).submitUploadFromBytes(
                mwn,
                Buffer.from('abc'),
                'x.png',
                'File:X.png',
                undefined,
                {},
            ),
        ).rejects.toMatchObject({ code: 'fileexists' });
    });
});

describe('submitUpload 本地文件', () => {
    it('普通文件按 basename 作为 multipart 名读取', async () => {
        const { mwn, requests } = makeMwn();
        await new EditServiceImpl([]).submitUpload(
            mwn,
            join(workDir, 'image.png'),
            'File:image.png',
            undefined,
            {},
        );
        const sent = requests[0]?.params ?? {};
        expect(sent.filename).toBe('File:image.png');
        const file = sent.file as { stream: Buffer; name: string };
        expect(file.name).toBe('image.png');
        expect(file.stream.toString('utf8')).toBe('PNGDATA');
    });

    it('目录不是普通文件，报 UploadValidationError', async () => {
        const { mwn, requests } = makeMwn();
        await expect(
            new EditServiceImpl([]).submitUpload(
                mwn,
                join(workDir, 'subdir'),
                'File:image.png',
                undefined,
                {},
            ),
        ).rejects.toThrow(UploadValidationError);
        expect(requests).toHaveLength(0);
    });

    it('不存在的路径按 fs 错误抛出', async () => {
        const { mwn } = makeMwn();
        await expect(
            new EditServiceImpl([]).submitUpload(
                mwn,
                join(workDir, 'nope.png'),
                'File:nope.png',
                undefined,
                {},
            ),
        ).rejects.toMatchObject({ code: 'ENOENT' });
    });
});

describe('assertUploadResult', () => {
    it('Success 通过', () => {
        expect(() => assertUploadResult({ result: 'Success' })).not.toThrow();
    });

    it('exists 映射为 fileexists', () => {
        expect(captureWarning({ result: 'Warning', warnings: { exists: '' } }).code).toBe(
            'fileexists',
        );
    });

    it('fileexists 映射为 fileexists', () => {
        expect(captureWarning({ result: 'Warning', warnings: { fileexists: 'X.png' } }).code).toBe(
            'fileexists',
        );
    });

    it('badfilename 映射为 badfilename', () => {
        expect(captureWarning({ result: 'Warning', warnings: { badfilename: 'bad' } }).code).toBe(
            'badfilename',
        );
    });

    it('其他警告映射为 upload-warning', () => {
        expect(
            captureWarning({ result: 'Warning', warnings: { 'verification-error': '' } }).code,
        ).toBe('upload-warning');
    });

    it('没有 warnings 的非 Success 也算失败', () => {
        expect(captureWarning({ result: 'Failure' }).code).toBe('upload-warning');
    });

    it('错误消息带上结果与警告名', () => {
        const error = captureWarning({ result: 'Warning', warnings: { exists: '' } });
        expect(error.message).toContain('Warning');
        expect(error.message).toContain('exists');
    });
});
