/**
 * get-random-pages 的单元测试。
 *
 * 覆盖：schema 默认值与越界拒绝、请求参数映射（过滤参数为 rnfilterredir）、
 * 结果映射（id → pageId，ns → namespace）、随机列表不产生续读标记。
 * 不联网：mwn.request 由替身记录参数并返回预设响应。
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ResponseFormatterImpl } from '../src/results/response.ts';
import type { ToolContext } from '../src/runtime/context.ts';
import { getRandomPages } from '../src/tools/get-random-pages.ts';

const schema = z.object(getRandomPages.inputSchema);

/** 记录请求参数、返回预设响应的 mwn 替身。 */
const makeCtx = (response: unknown = { batchcomplete: true, query: { random: [] } }) => {
    const requests: Record<string, unknown>[] = [];
    const mwn = {
        request: async (params: Record<string, unknown>) => {
            requests.push(params);
            return response;
        },
    };
    const ctx = {
        mwn: async () => mwn,
        format: new ResponseFormatterImpl(),
    } as unknown as ToolContext;
    return { ctx, requests };
};

describe('get-random-pages 请求参数', () => {
    it('省略参数时使用 schema 默认值', async () => {
        expect(schema.parse({})).toEqual({ namespace: 0, filter: 'nonredirects', limit: 10 });
    });

    it('默认值随请求发出', async () => {
        const { ctx, requests } = makeCtx();
        await getRandomPages.handle(schema.parse({}), ctx);
        expect(requests[0]).toEqual({
            action: 'query',
            list: 'random',
            rnnamespace: 0,
            rnlimit: 10,
            rnfilterredir: 'nonredirects',
            formatversion: '2',
        });
    });

    it('显式参数逐个映射，且不发 rncontinue', async () => {
        const { ctx, requests } = makeCtx();
        await getRandomPages.handle(
            schema.parse({ namespace: 6, filter: 'redirects', limit: 42 }),
            ctx,
        );
        expect(requests[0]).toEqual({
            action: 'query',
            list: 'random',
            rnnamespace: 6,
            rnlimit: 42,
            rnfilterredir: 'redirects',
            formatversion: '2',
        });
        expect(Object.hasOwn(requests[0] ?? {}, 'rncontinue')).toBe(false);
    });

    it('filter=all 原样发出', async () => {
        const { ctx, requests } = makeCtx();
        await getRandomPages.handle(schema.parse({ filter: 'all' }), ctx);
        expect(requests[0]?.rnfilterredir).toBe('all');
    });
});

describe('get-random-pages 结果映射', () => {
    it('id 映射为 pageId、ns 映射为 namespace', async () => {
        const { ctx } = makeCtx({
            batchcomplete: true,
            query: {
                random: [
                    { id: 1, ns: 0, title: '首页' },
                    { id: 2, ns: 10, title: 'Template:Infobox' },
                ],
            },
        });
        const result = await getRandomPages.handle(schema.parse({}), ctx);
        expect(result.structuredContent).toEqual({
            pages: [
                { title: '首页', pageId: 1, namespace: 0 },
                { title: 'Template:Infobox', pageId: 2, namespace: 10 },
            ],
        });
    });

    it('没有条目时返回空数组', async () => {
        const { ctx } = makeCtx({ batchcomplete: true, query: {} });
        const result = await getRandomPages.handle(schema.parse({}), ctx);
        expect(result.structuredContent).toEqual({ pages: [] });
    });

    it('上游给了 continue 也不返回续读标记', async () => {
        const { ctx } = makeCtx({
            continue: { rncontinue: 'next', continue: '||' },
            query: { random: [{ id: 7, ns: 0, title: '随机页' }] },
        });
        const result = await getRandomPages.handle(schema.parse({ limit: 20 }), ctx);
        expect(result.structuredContent).toEqual({
            pages: [{ title: '随机页', pageId: 7, namespace: 0 }],
        });
    });
});

describe('get-random-pages schema 校验', () => {
    it('接受 limit 边界 1 与 500', () => {
        expect(schema.safeParse({ limit: 1 }).success).toBe(true);
        expect(schema.safeParse({ limit: 500 }).success).toBe(true);
    });

    it('拒绝 limit 501 与 0', () => {
        expect(schema.safeParse({ limit: 501 }).success).toBe(false);
        expect(schema.safeParse({ limit: 0 }).success).toBe(false);
    });

    it('拒绝负 namespace 与非整数 namespace', () => {
        expect(schema.safeParse({ namespace: -1 }).success).toBe(false);
        expect(schema.safeParse({ namespace: 1.5 }).success).toBe(false);
    });

    it('拒绝未知 filter', () => {
        expect(schema.safeParse({ filter: 'bogus' }).success).toBe(false);
    });
});
