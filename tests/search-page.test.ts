/**
 * search-page 的单元测试。
 *
 * 覆盖：CirrusSearch 的 srwhat/srinfo 参数、what 参数映射、
 * searchinfo 的 totalHits/suggestion 映射、截断提示里的命中总数，
 * 以及显式命名空间仍发送 srnamespace。
 */

import type { ApiParams } from 'mwn';
import { describe, expect, it } from 'vitest';
import type { WikiConfig } from '../src/config/loadConfig.ts';
import { ResponseFormatterImpl } from '../src/results/response.ts';
import type { ToolContext } from '../src/runtime/context.ts';
import { searchPage } from '../src/tools/search-page.ts';
import type { SiteInfo } from '../src/wikis/siteInfoCache.ts';

const siteInfo: SiteInfo = {
    server: 'https://wiki.example.org',
    articlepath: '/test',
    contentNamespaces: [0, 10, 14],
};

/** 记录请求参数，返回预设响应的 mwn 替身。 */
const makeCtx = (
    response: unknown = {
        batchcomplete: true,
        query: { search: [] },
    },
) => {
    const requests: Record<string, unknown>[] = [];
    const mwn = {
        request: async (params: ApiParams) => {
            requests.push(params as Record<string, unknown>);
            return response;
        },
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
        format: new ResponseFormatterImpl(),
    } as unknown as ToolContext;
    return { ctx, requests };
};

const searchEntry = (overrides: Record<string, unknown> = {}) => ({
    ns: 0,
    title: '角色',
    pageid: 1,
    size: 1024,
    wordcount: 128,
    snippet: '角色 <span class="searchmatch">介绍</span>',
    timestamp: '2026-01-02T03:04:05Z',
    ...overrides,
});

describe('search-page CirrusSearch 参数', () => {
    it('默认发送 srwhat=text 与 srinfo', async () => {
        const { ctx, requests } = makeCtx();
        await searchPage.handle({ query: '角色' }, ctx);
        expect(requests[0]).toMatchObject({
            srwhat: 'text',
            srinfo: 'totalhits|suggestion|rewrittenquery',
            srprop: 'snippet|size|timestamp|wordcount',
        });
    });

    it('what=title 映射为 srwhat=title', async () => {
        const { ctx, requests } = makeCtx();
        await searchPage.handle({ query: '角色', what: 'title' }, ctx);
        expect(requests[0]?.srwhat).toBe('title');
    });

    it('what=nearmatch 映射为 srwhat=nearmatch', async () => {
        const { ctx, requests } = makeCtx();
        await searchPage.handle({ query: '角色', what: 'nearmatch' }, ctx);
        expect(requests[0]?.srwhat).toBe('nearmatch');
    });

    it('未指定命名空间时使用 wiki 的内容命名空间', async () => {
        const { ctx, requests } = makeCtx();
        await searchPage.handle({ query: '角色' }, ctx);
        expect(requests[0]?.srnamespace).toBe('0|10|14');
    });

    it('显式命名空间仍发送 srnamespace', async () => {
        const { ctx, requests } = makeCtx();
        await searchPage.handle({ query: '角色', namespaces: [0, 6] }, ctx);
        expect(requests[0]?.srnamespace).toBe('0|6');
    });

    it('limit 仍发送 srlimit', async () => {
        const { ctx, requests } = makeCtx();
        await searchPage.handle({ query: '角色', limit: 42 }, ctx);
        expect(requests[0]?.srlimit).toBe(42);
    });
});

describe('search-page searchinfo 映射', () => {
    it('映射 totalHits 与 suggestion', async () => {
        const { ctx } = makeCtx({
            batchcomplete: true,
            query: {
                search: [searchEntry()],
                searchinfo: { totalhits: 1234, suggestion: '角色列表' },
            },
        });
        const result = await searchPage.handle({ query: '角设' }, ctx);
        expect(result.structuredContent).toMatchObject({
            totalHits: 1234,
            suggestion: '角色列表',
        });
    });

    it('searchinfo 缺失时不输出 totalHits 与 suggestion', async () => {
        const { ctx } = makeCtx({
            batchcomplete: true,
            query: { search: [searchEntry()] },
        });
        const result = await searchPage.handle({ query: '角色' }, ctx);
        const payload = result.structuredContent as Record<string, unknown>;
        expect(Object.hasOwn(payload, 'totalHits')).toBe(false);
        expect(Object.hasOwn(payload, 'suggestion')).toBe(false);
    });

    it('totalhits 非数字或 suggestion 为空时省略对应字段', async () => {
        const { ctx } = makeCtx({
            batchcomplete: true,
            query: {
                search: [searchEntry()],
                searchinfo: { totalhits: '1234', suggestion: '' },
            },
        });
        const result = await searchPage.handle({ query: '角色' }, ctx);
        const payload = result.structuredContent as Record<string, unknown>;
        expect(Object.hasOwn(payload, 'totalHits')).toBe(false);
        expect(Object.hasOwn(payload, 'suggestion')).toBe(false);
    });

    it('结果与截断结构保持兼容', async () => {
        const { ctx } = makeCtx({
            batchcomplete: true,
            query: { search: [searchEntry()] },
        });
        const result = await searchPage.handle({ query: '角色' }, ctx);
        expect(result.structuredContent).toEqual({
            results: [
                {
                    title: '角色',
                    pageId: 1,
                    namespace: 0,
                    snippet: '角色 <span class="searchmatch">介绍</span>',
                    size: 1024,
                    wordCount: 128,
                    timestamp: '2026-01-02T03:04:05Z',
                    url: 'https://wiki.example.org/test/%E8%A7%92%E8%89%B2',
                },
            ],
        });
    });
});

describe('search-page 截断提示', () => {
    it('已知 totalHits 时截断提示带上命中总数', async () => {
        const { ctx } = makeCtx({
            continue: { sroffset: 1, continue: '||' },
            query: {
                search: [searchEntry()],
                searchinfo: { totalhits: 987 },
            },
        });
        const result = await searchPage.handle({ query: '角色', limit: 1 }, ctx);
        expect(result.structuredContent).toMatchObject({
            truncation: {
                reason: 'capped-no-continuation',
                returnedCount: 1,
                limit: 1,
                itemNoun: 'matches',
            },
        });
        const truncation = (result.structuredContent as { truncation: { narrowHint: string } })
            .truncation;
        expect(truncation.narrowHint).toContain('matched 987 pages');
    });

    it('未知 totalHits 时沿用原有截断提示', async () => {
        const { ctx } = makeCtx({
            continue: { sroffset: 1, continue: '||' },
            query: { search: [searchEntry()] },
        });
        const result = await searchPage.handle({ query: '角色', limit: 1 }, ctx);
        const truncation = (result.structuredContent as { truncation: { narrowHint: string } })
            .truncation;
        expect(truncation.narrowHint).toBe('narrow the query or raise limit (max 100)');
    });
});
