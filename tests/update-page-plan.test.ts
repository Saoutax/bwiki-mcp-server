/**
 * update-page 的写入计划校验。
 *
 * 覆盖点：section 大于 0 时所有写操作都必须带 latestId（find-replace 自行读版本、
 * 按所读版本提交，是唯一例外）、section 0 保持无需 latestId、latestId 作为
 * baserevid 送达编辑接口。
 */

import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Mwn } from 'mwn';
import { describe, expect, it } from 'vitest';
import { DEFAULT_EDIT_SUMMARY } from '../src/config/editSummary.ts';
import { ResponseFormatterImpl } from '../src/results/response.ts';
import type { ToolContext } from '../src/runtime/context.ts';
import { updatePage } from '../src/tools/update-page.ts';

const SITE_INFO = { server: 'https://wiki.biligame.com', articlepath: '/demo' };

const makeCtx = (mwn: Mwn, submitted: Record<string, unknown>[]): ToolContext =>
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
        edit: {
            submit: async (_mwn: Mwn, params: Record<string, unknown>) => {
                submitted.push(params);
                return {
                    edit: {
                        result: 'Success',
                        pageid: 1,
                        title: params.title,
                        newrevid: 42,
                        newtimestamp: '2026-01-01T00:00:00Z',
                        contentmodel: 'wikitext',
                    },
                };
            },
            botRight: async () => true,
        },
        editSummary: DEFAULT_EDIT_SUMMARY,
        format: new ResponseFormatterImpl(),
        // 只需以上字段；其余成员在本次校验与提交路径上不会被读取。
    }) as unknown as ToolContext;

const fakeMwn = (readResult?: Record<string, unknown>): Mwn =>
    ({
        request: async () => ({ query: { pages: [{ length: 10 }] } }),
        read: async () =>
            readResult ?? { pageid: 1, title: 'P', revisions: [{ revid: 5, content: 'abc' }] },
    }) as unknown as Mwn;

const envelopeOf = (result: CallToolResult): { category: string; message: string } => {
    const block = result.content[0];
    const text = block !== undefined && 'text' in block ? String(block.text) : '';
    return JSON.parse(text) as { category: string; message: string };
};

const run = async (
    args: Parameters<typeof updatePage.handle>[0],
    readResult?: Record<string, unknown>,
): Promise<{ result: CallToolResult; submitted: Record<string, unknown>[] }> => {
    const submitted: Record<string, unknown>[] = [];
    const mwn = fakeMwn(readResult);
    const ctx = makeCtx(mwn, submitted);
    const result = await updatePage.handle(args, ctx);
    return { result, submitted };
};

describe('分节写入需要 latestId', () => {
    it.each(['replace', 'append', 'prepend'] as const)(
        'operation=%s 且 section>0 时缺 latestId 被拒绝',
        async operation => {
            const { result, submitted } = await run({
                title: 'P',
                operation,
                source: 'new text',
                section: 1,
            });

            expect(submitted).toEqual([]);
            expect(result.isError).toBe(true);
            const envelope = envelopeOf(result);
            expect(envelope.category).toBe('invalid_input');
            expect(envelope.message).toContain('Section 1');
            expect(envelope.message).toContain('latestId');
            // 报错说明按哪个版本解析节号，而非只说 replace 需要。
            expect(envelope.message).toContain('revision');
        },
    );

    it('旧写法 mode 同样受约束', async () => {
        const { result, submitted } = await run({
            title: 'P',
            mode: 'append',
            source: 'delta',
            section: 2,
        });

        expect(submitted).toEqual([]);
        expect(envelopeOf(result).category).toBe('invalid_input');
    });

    it('section 0 不要求 latestId（保持原行为）', async () => {
        const { result, submitted } = await run({
            title: 'P',
            operation: 'append',
            source: 'delta',
            section: 0,
        });

        expect(result.isError).toBeUndefined();
        expect(submitted).toHaveLength(1);
        expect(submitted[0].section).toBe('0');
        expect(Object.hasOwn(submitted[0], 'baserevid')).toBe(false);
    });

    it('带 latestId 的分节 append 以 baserevid 提交', async () => {
        const { submitted } = await run({
            title: 'P',
            operation: 'append',
            source: 'delta',
            section: 2,
            latestId: 100,
        });

        expect(submitted).toHaveLength(1);
        expect(submitted[0].section).toBe('2');
        expect(submitted[0].baserevid).toBe(100);
    });

    it('带 latestId 的分节 replace 同样提交', async () => {
        const { result, submitted } = await run({
            title: 'P',
            operation: 'replace',
            source: 'new text',
            section: 1,
            latestId: 100,
        });

        expect(result.isError).toBeUndefined();
        expect(submitted[0].baserevid).toBe(100);
    });

    it('整页写入不需要 latestId', async () => {
        const { result, submitted } = await run({
            title: 'P',
            operation: 'append',
            source: 'delta',
        });

        expect(result.isError).toBeUndefined();
        expect(Object.hasOwn(submitted[0], 'section')).toBe(false);
        expect(Object.hasOwn(submitted[0], 'baserevid')).toBe(false);
    });
});

describe('find-replace 豁免', () => {
    it('分节 find-replace 无需 latestId，按所读版本提交', async () => {
        const { result, submitted } = await run({
            title: 'P',
            operation: 'find-replace',
            find: 'a',
            replaceWith: 'b',
            section: 1,
        });

        expect(result.isError).toBeUndefined();
        expect(submitted).toHaveLength(1);
        expect(submitted[0].text).toBe('bbc');
        expect(submitted[0].baserevid).toBe(5);
    });
});
