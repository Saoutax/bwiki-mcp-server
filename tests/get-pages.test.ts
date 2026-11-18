/**
 * get-pages 的读取与载荷测试。
 *
 * 覆盖点：followRedirects:false 走 request 且保留 normalized 别名、
 * invalid 标题单独报告、续读标记以数组交付页面名、字节预算的省略语义。
 */

import type { Mwn } from 'mwn';
import { describe, expect, it } from 'vitest';
import { ResponseFormatterImpl } from '../src/results/response.ts';
import type { ToolContext } from '../src/runtime/context.ts';
import { RevisionNormalizerImpl } from '../src/services/revisionNormalize.ts';
import { applyResponseBudget, BatchContentFormat, getPages } from '../src/tools/get-pages.ts';

const SITE_INFO = { server: 'https://wiki.biligame.com', articlepath: '/demo' };

const makeCtx = (mwn: Mwn): ToolContext =>
    ({
        mwn: async () => mwn,
        wikis: {
            get: () => undefined,
            getAll: () => ({}),
            add: () => undefined,
            remove: () => undefined,
            isManagementAllowed: () => false,
        },
        activeWiki: {
            get: () => ({
                key: 'demo',
                config: {
                    sitename: 'Demo',
                    server: 'https://wiki.biligame.com/demo',
                    articlepath: '/demo/$1',
                    scriptpath: '/w',
                },
            }),
        },
        siteInfoCache: {
            get: () => SITE_INFO,
            isFresh: () => true,
            set: () => undefined,
            deferRefetch: () => undefined,
            delete: () => undefined,
        },
        sections: {
            list: async () => [],
            listInSource: async () => [],
        },
        revision: new RevisionNormalizerImpl(),
        format: new ResponseFormatterImpl(),
    }) as unknown as ToolContext;

interface PayloadPage {
    title?: string;
    requestedTitle?: string;
    latestRevisionId?: number;
    url?: string;
    source?: string;
}

interface PagesPayload {
    pages: PayloadPage[];
    missing?: string[];
    invalid?: string[];
    truncation?: {
        reason: string;
        returnedCount: number;
        continueWith?: { param: string; value: unknown };
    };
}

const payloadOf = (structuredContent: unknown): PagesPayload => structuredContent as PagesPayload;

const pageWithContent = (
    title: string,
    content: string,
    revid: number,
): Record<string, unknown> => ({
    pageid: revid,
    title,
    revisions: [
        {
            revid,
            timestamp: '2026-01-01T00:00:00Z',
            contentmodel: 'wikitext',
            slots: { main: { content } },
        },
    ],
});

describe('followRedirects: false', () => {
    it('用 request 取页并按 normalized 还原请求标题', async () => {
        const calls: Record<string, unknown>[] = [];
        let readCalled = false;
        const mwn = {
            request: async (params: Record<string, unknown>) => {
                calls.push(params);
                return {
                    query: {
                        normalized: [{ from: 'foo_bar', to: 'Foo bar' }],
                        pages: [pageWithContent('Foo bar', 'hello', 11)],
                    },
                };
            },
            massQuery: async () => {
                throw new Error('massQuery should not run');
            },
            read: async () => {
                readCalled = true;
                throw new Error('read should not run');
            },
        } as unknown as Mwn;

        const result = await getPages.handle(
            {
                titles: ['foo_bar'],
                content: BatchContentFormat.source,
                metadata: true,
                followRedirects: false,
            },
            makeCtx(mwn),
        );

        expect(readCalled).toBe(false);
        expect(calls[0]).toMatchObject({
            action: 'query',
            titles: ['foo_bar'],
            prop: 'revisions',
            rvslots: 'main',
            redirects: false,
            formatversion: '2',
        });

        const payload = payloadOf(result.structuredContent);
        expect(payload.pages).toHaveLength(1);
        expect(payload.pages[0].title).toBe('Foo bar');
        expect(payload.pages[0].requestedTitle).toBe('foo_bar');
        expect(payload.pages[0].latestRevisionId).toBe(11);
        expect(payload.pages[0].url).toBe('https://wiki.biligame.com/demo/Foo_bar');
    });
});

describe('无效标题', () => {
    it('invalid 页面单独列出，与 missing 并列', async () => {
        const mwn = {
            request: async () => ({
                query: {
                    pages: [
                        { title: '[', invalid: true },
                        { title: 'Gone', missing: true },
                        pageWithContent('Stay', 'kept', 3),
                    ],
                },
            }),
        } as unknown as Mwn;

        const result = await getPages.handle(
            {
                titles: ['[', 'Gone', 'Stay'],
                content: BatchContentFormat.source,
                metadata: false,
                followRedirects: false,
            },
            makeCtx(mwn),
        );

        const payload = payloadOf(result.structuredContent);
        expect(payload.invalid).toEqual(['[']);
        expect(payload.missing).toEqual(['Gone']);
        expect(payload.pages.map(p => p.title)).toEqual(['Stay']);
    });
});

describe('响应预算', () => {
    it('applyResponseBudget 截断首个超预算页面并省略其后页面', () => {
        const previous = process.env.MCP_CONTENT_MAX_BYTES;
        process.env.MCP_CONTENT_MAX_BYTES = '5';
        try {
            const entries: { title: string; source?: string }[] = [
                { title: 'Big', source: 'abcdefghij' },
                { title: 'Small', source: 'x' },
            ];
            const pending: {
                entryIndex: number;
                title: string;
                returnedBytes: number;
                totalBytes: number;
            }[] = [];

            const omitted = applyResponseBudget(entries, pending);

            expect(omitted).toEqual(['Small']);
            expect(entries).toHaveLength(1);
            expect(entries[0].source).toBe('abcde');
            expect(pending).toEqual([
                { entryIndex: 0, title: 'Big', returnedBytes: 5, totalBytes: 10 },
            ]);
        } finally {
            if (previous === undefined) {
                delete process.env.MCP_CONTENT_MAX_BYTES;
            } else {
                process.env.MCP_CONTENT_MAX_BYTES = previous;
            }
        }
    });

    it('省略页面的续读标记以数组交付页面名', async () => {
        const previous = process.env.MCP_CONTENT_MAX_BYTES;
        process.env.MCP_CONTENT_MAX_BYTES = '10';
        try {
            const mwn = {
                request: async () => ({
                    query: {
                        pages: [
                            pageWithContent('Alpha', 'aaaaaaaaaa', 1),
                            pageWithContent('Beta', 'bbbbbbbbbb', 2),
                        ],
                    },
                }),
            } as unknown as Mwn;

            const result = await getPages.handle(
                {
                    titles: ['Alpha', 'Beta'],
                    content: BatchContentFormat.source,
                    metadata: false,
                    followRedirects: false,
                },
                makeCtx(mwn),
            );

            const payload = payloadOf(result.structuredContent);
            expect(payload.pages.map(p => p.title)).toEqual(['Alpha']);
            expect(payload.truncation?.reason).toBe('more-available');
            expect(payload.truncation?.returnedCount).toBe(1);
            expect(payload.truncation?.continueWith).toEqual({
                param: 'titles',
                value: ['Beta'],
            });
        } finally {
            if (previous === undefined) {
                delete process.env.MCP_CONTENT_MAX_BYTES;
            } else {
                process.env.MCP_CONTENT_MAX_BYTES = previous;
            }
        }
    });
});
