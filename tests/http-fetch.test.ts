/**
 * 受控 HTTP 抓取的单元测试。
 *
 * node-fetch 与 SSRF 校验被替换为测试替身，请求不出本机。
 * 覆盖：字节上限（声明长度与流式累计）、content-type 提取、非 2xx 归类，
 * 以及 shouldRescueToWiki 的放行/拒绝规则。
 */

import { Readable } from 'node:stream';
import fetch, { FetchError } from 'node-fetch';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/ssrfGuard.ts', () => {
    class SsrfValidationError extends Error {
        public constructor(message: string) {
            super(message);
            this.name = 'SsrfValidationError';
        }
    }
    return {
        SsrfValidationError,
        assertPublicDestination: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
        buildPinnedAgent: vi.fn(() => ({})),
    };
});

vi.mock('node-fetch', () => {
    class FetchError extends Error {
        public constructor(message: string) {
            super(message);
            this.name = 'FetchError';
        }
    }
    return {
        default: vi.fn(),
        Response: class Response {},
        FetchError,
    };
});

import {
    fetchFileBytes,
    fetchGuardedBytes,
    FileTooLargeError,
    HttpStatusError,
    shouldRescueToWiki,
} from '../src/httpFetch.ts';
import { SsrfValidationError } from '../src/ssrfGuard.ts';

const fetchMock = fetch as unknown as Mock;

interface FakeResponseOptions {
    contentType?: string;
    contentLength?: number;
    status?: number;
}

/** node-fetch Response 的最小替身：本模块只读 ok/status/headers/body。 */
const makeResponse = (body: Buffer, options: FakeResponseOptions = {}) => {
    const headers = new Headers();
    if (options.contentType !== undefined) {
        headers.set('content-type', options.contentType);
    }
    if (options.contentLength !== undefined) {
        headers.set('content-length', String(options.contentLength));
    }
    const status = options.status ?? 200;
    return {
        ok: status >= 200 && status < 300,
        status,
        url: 'https://example.org/file.bin',
        headers,
        body: Readable.from([body]),
    };
};

const abortError = (): Error => {
    const error = new Error('The operation was aborted.');
    error.name = 'AbortError';
    return error;
};

beforeEach(() => {
    vi.clearAllMocks();
});

afterEach(() => {
    delete process.env.MCP_UPLOAD_MAX_BYTES;
});

describe('fetchGuardedBytes', () => {
    it('返回字节与去掉参数的 content-type', async () => {
        fetchMock.mockResolvedValue(
            makeResponse(Buffer.from('abc'), { contentType: 'image/png; charset=binary' }),
        );
        const result = await fetchGuardedBytes('https://example.org/file.png');
        expect(result.bytes.toString('utf8')).toBe('abc');
        expect(result.contentType).toBe('image/png');
    });

    it('没有 content-type 时该字段缺省', async () => {
        fetchMock.mockResolvedValue(makeResponse(Buffer.from('abc')));
        const result = await fetchGuardedBytes('https://example.org/file.png');
        expect(result.contentType).toBeUndefined();
    });

    it('透传请求头', async () => {
        fetchMock.mockResolvedValue(makeResponse(Buffer.from('abc')));
        await fetchGuardedBytes('https://example.org/file.png', {
            headers: { Authorization: 'Bearer x' },
        });
        const options = fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string> };
        expect(options.headers.Authorization).toBe('Bearer x');
    });

    it('声明长度超限时提前拒绝', async () => {
        fetchMock.mockResolvedValue(makeResponse(Buffer.alloc(0), { contentLength: 100 }));
        await expect(
            fetchGuardedBytes('https://example.org/file.bin', { maxBytes: 10 }),
        ).rejects.toBeInstanceOf(FileTooLargeError);
    });

    it('流式累计超限时拒绝', async () => {
        fetchMock.mockResolvedValue(makeResponse(Buffer.alloc(32)));
        await expect(
            fetchGuardedBytes('https://example.org/file.bin', { maxBytes: 10 }),
        ).rejects.toBeInstanceOf(FileTooLargeError);
    });

    it('非 2xx 抛 HttpStatusError', async () => {
        fetchMock.mockResolvedValue(makeResponse(Buffer.from('nope'), { status: 404 }));
        await expect(fetchGuardedBytes('https://example.org/missing.png')).rejects.toBeInstanceOf(
            HttpStatusError,
        );
    });

    it('调用方已取消时不发起请求', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(
            fetchGuardedBytes('https://example.org/file.png', { signal: controller.signal }),
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('SSRF 校验失败向上抛出', async () => {
        const { assertPublicDestination } = await import('../src/ssrfGuard.ts');
        vi.mocked(assertPublicDestination).mockRejectedValueOnce(
            new SsrfValidationError('non-public address'),
        );
        await expect(fetchGuardedBytes('https://internal.example/file.png')).rejects.toBeInstanceOf(
            SsrfValidationError,
        );
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('fetchFileBytes', () => {
    it('返回原始字节', async () => {
        fetchMock.mockResolvedValue(makeResponse(Buffer.from('abcdef')));
        await expect(fetchFileBytes('https://example.org/file.bin')).resolves.toEqual(
            Buffer.from('abcdef'),
        );
    });

    it('默认上限读取 MCP_UPLOAD_MAX_BYTES，错误消息带上设置名', async () => {
        process.env.MCP_UPLOAD_MAX_BYTES = '5';
        fetchMock.mockResolvedValue(makeResponse(Buffer.alloc(16)));
        await expect(fetchFileBytes('https://example.org/file.bin')).rejects.toThrow(
            /MCP_UPLOAD_MAX_BYTES/,
        );
    });
});

describe('shouldRescueToWiki', () => {
    it('SSRF 拒绝是最终结论，不转交 wiki', () => {
        expect(shouldRescueToWiki(new SsrfValidationError('non-public'))).toBe(false);
    });

    it('调用方已取消时不转交', () => {
        const controller = new AbortController();
        controller.abort();
        expect(shouldRescueToWiki(new FileTooLargeError(10, 5), controller.signal)).toBe(false);
    });

    it('源站超限转交', () => {
        expect(shouldRescueToWiki(new FileTooLargeError(10, 5))).toBe(true);
    });

    it('网络错误转交', () => {
        expect(shouldRescueToWiki(new FetchError('socket hang up', 'system'))).toBe(true);
    });

    it('源站拒绝请求不转交', () => {
        expect(shouldRescueToWiki(new HttpStatusError(404, 'https://example.org/x'))).toBe(false);
    });

    it('内部超时的 AbortError 转交', () => {
        expect(shouldRescueToWiki(abortError())).toBe(true);
    });

    it('可救援的 errno 转交', () => {
        const error = new Error('connect refused') as NodeJS.ErrnoException;
        error.code = 'ECONNREFUSED';
        expect(shouldRescueToWiki(error)).toBe(true);
    });

    it('未知错误不转交', () => {
        expect(shouldRescueToWiki(new Error('boom'))).toBe(false);
    });
});
