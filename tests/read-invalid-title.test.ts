/**
 * 读取类工具对无效标题（`invalid: true`）的处理。
 *
 * API 对非法标题返回 `invalid` 而非 `missing`，两者下一步动作不同：
 * 前者要改标题，后者要改工具。故必须报 invalid_input，不能报 not_found。
 */

import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Mwn } from 'mwn';
import { describe, expect, it } from 'vitest';
import { ContentFormat } from '../src/results/contentFormat.ts';
import { ResponseFormatterImpl } from '../src/results/response.ts';
import type { ToolContext } from '../src/runtime/context.ts';
import { getPageHistory } from '../src/tools/get-page-history.ts';
import { getPage } from '../src/tools/get-page.ts';

const makeCtx = (mwn: Mwn): ToolContext =>
    ({ mwn: async () => mwn, format: new ResponseFormatterImpl() }) as unknown as ToolContext;

const envelopeOf = (result: CallToolResult): { category: string; message: string } => {
    const block = result.content[0];
    const text = block !== undefined && 'text' in block ? String(block.text) : '';
    return JSON.parse(text) as { category: string; message: string };
};

describe('get-page 无效标题', () => {
    it('报 invalid_input 而不是 not_found', async () => {
        let readTitle: string | undefined;
        const mwn = {
            read: async (title: string) => {
                readTitle = title;
                return { invalid: true, title };
            },
        } as unknown as Mwn;

        const result = await getPage.handle(
            {
                title: '[',
                content: ContentFormat.source,
                metadata: false,
                section: undefined,
                includePending: false,
            },
            makeCtx(mwn),
        );

        expect(readTitle).toBe('[');
        expect(result.isError).toBe(true);
        expect(envelopeOf(result)).toEqual({
            category: 'invalid_input',
            message: '"[" is not a valid page title',
        });
    });

    it('missing 仍报 not_found', async () => {
        const mwn = {
            read: async () => ({ missing: true, title: 'Nope' }),
        } as unknown as Mwn;

        const result = await getPage.handle(
            {
                title: 'Nope',
                content: ContentFormat.source,
                metadata: false,
                section: undefined,
                includePending: false,
            },
            makeCtx(mwn),
        );

        expect(envelopeOf(result).category).toBe('not_found');
        expect(envelopeOf(result).message).toContain('not found');
    });
});

describe('get-page-history 无效标题', () => {
    it('报 invalid_input 而不是 not_found', async () => {
        const mwn = {
            request: async () => ({ query: { pages: [{ invalid: true, title: '[' }] } }),
        } as unknown as Mwn;

        const result = await getPageHistory.handle(
            { title: '[', olderThan: undefined, newerThan: undefined, filter: undefined },
            makeCtx(mwn),
        );

        expect(result.isError).toBe(true);
        expect(envelopeOf(result)).toEqual({
            category: 'invalid_input',
            message: '"[" is not a valid page title',
        });
    });

    it('missing 仍报 not_found', async () => {
        const mwn = {
            request: async () => ({ query: { pages: [{ missing: true, title: 'Nope' }] } }),
        } as unknown as Mwn;

        const result = await getPageHistory.handle(
            { title: 'Nope', olderThan: undefined, newerThan: undefined, filter: undefined },
            makeCtx(mwn),
        );

        expect(envelopeOf(result).category).toBe('not_found');
    });
});
