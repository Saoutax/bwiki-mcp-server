/**
 * search-page-by-prefix 的单元测试。
 *
 * 覆盖：已知命名空间前缀被拆成 apnamespace + apprefix、显式命名空间冲突、
 * 未知前缀保留冒号、结果与截断标记的映射。
 */

import type { ApiParams } from 'mwn';
import { describe, expect, it } from 'vitest';
import type { WikiConfig } from '../src/config/loadConfig.ts';
import { ResponseFormatterImpl } from '../src/results/response.ts';
import type { ToolContext } from '../src/runtime/context.ts';
import { searchPageByPrefix } from '../src/tools/search-page-by-prefix.ts';
import type { SiteInfo } from '../src/wikis/siteInfoCache.ts';

const siteInfo: SiteInfo = {
    server: 'https://wiki.example.org',
    articlepath: '/test',
    namespaceNames: { file: 6, 文件: 6, category: 14, 分类: 14, template: 10 },
    namespaceCanonical: { 6: 'File', 14: 'Category', 10: 'Template' },
};

/** 记录请求参数，返回预设响应的 mwn 替身。 */
const makeCtx = (response: unknown = { batchcomplete: true, query: { allpages: [] } }) => {
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

const envelopeOf = (result: { content: unknown[] }): { category: string; message: string } => {
    const first = result.content[0] as { text: string } | undefined;
    return JSON.parse(first?.text ?? '{}') as { category: string; message: string };
};

describe('search-page-by-prefix 命名空间前缀', () => {
    it('已知前缀被拆成裸前缀与 apnamespace', async () => {
        const { ctx, requests } = makeCtx();
        await searchPageByPrefix.handle({ prefix: 'File:Ab' }, ctx);
        expect(requests[0]).toMatchObject({ apprefix: 'Ab', apnamespace: 6 });
    });

    it('本地化前缀同样被拆开', async () => {
        const { ctx, requests } = makeCtx();
        await searchPageByPrefix.handle({ prefix: '分类:角色' }, ctx);
        expect(requests[0]).toMatchObject({ apprefix: '角色', apnamespace: 14 });
    });

    it('显式命名空间与推断一致时通过', async () => {
        const { ctx, requests } = makeCtx();
        await searchPageByPrefix.handle({ prefix: 'File:Ab', namespace: 6 }, ctx);
        expect(requests[0]).toMatchObject({ apprefix: 'Ab', apnamespace: 6 });
    });

    it('显式命名空间与推断冲突时返回 invalid_input', async () => {
        const { ctx, requests } = makeCtx();
        const result = await searchPageByPrefix.handle({ prefix: 'File:Ab', namespace: 14 }, ctx);
        expect(result.isError).toBe(true);
        expect(envelopeOf(result).category).toBe('invalid_input');
        expect(requests).toHaveLength(0);
    });

    it('前缀后没有文本时返回 invalid_input', async () => {
        const { ctx } = makeCtx();
        const result = await searchPageByPrefix.handle({ prefix: 'File:' }, ctx);
        expect(envelopeOf(result).category).toBe('invalid_input');
    });

    it('无前缀时保留显式命名空间', async () => {
        const { ctx, requests } = makeCtx();
        await searchPageByPrefix.handle({ prefix: 'Ab', namespace: 0 }, ctx);
        expect(requests[0]).toMatchObject({ apprefix: 'Ab', apnamespace: 0 });
    });

    it('无前缀且未指定命名空间时不发送 apnamespace', async () => {
        const { ctx, requests } = makeCtx();
        await searchPageByPrefix.handle({ prefix: 'Ab' }, ctx);
        expect(requests[0]).toMatchObject({ apprefix: 'Ab' });
        expect(Object.hasOwn(requests[0] ?? {}, 'apnamespace')).toBe(false);
    });

    it('未知前缀的冒号保留在 apprefix 中', async () => {
        const { ctx, requests } = makeCtx();
        await searchPageByPrefix.handle({ prefix: 'Foo:Bar' }, ctx);
        expect(requests[0]).toMatchObject({ apprefix: 'Foo:Bar' });
        expect(Object.hasOwn(requests[0] ?? {}, 'apnamespace')).toBe(false);
    });
});

describe('search-page-by-prefix 结果映射', () => {
    it('映射标题、pageId 与命名空间', async () => {
        const { ctx } = makeCtx({
            batchcomplete: true,
            query: {
                allpages: [
                    { pageid: 1, ns: 0, title: 'Abc' },
                    { pageid: 2, ns: 6, title: 'File:Abc.png' },
                ],
            },
        });
        const result = await searchPageByPrefix.handle({ prefix: 'Ab', namespace: 0 }, ctx);
        expect(result.structuredContent).toEqual({
            results: [
                { title: 'Abc', pageId: 1, namespace: 0 },
                { title: 'File:Abc.png', pageId: 2, namespace: 6 },
            ],
        });
    });

    it('有 continue 时带上截断标记', async () => {
        const { ctx } = makeCtx({
            continue: { apcontinue: 'next', continue: '||' },
            query: { allpages: [{ pageid: 1, ns: 0, title: 'Abc' }] },
        });
        const result = await searchPageByPrefix.handle({ prefix: 'Ab', limit: 1 }, ctx);
        expect(result.structuredContent).toMatchObject({
            truncation: {
                reason: 'capped-no-continuation',
                returnedCount: 1,
                limit: 1,
                itemNoun: 'titles',
            },
        });
    });

    it('aplimit 随 limit 发送', async () => {
        const { ctx, requests } = makeCtx();
        await searchPageByPrefix.handle({ prefix: 'Ab', limit: 42 }, ctx);
        expect(requests[0]?.aplimit).toBe(42);
    });
});
