/**
 * MediaWiki diff HTML 到文本的转换。
 *
 * 覆盖点：行号行的文案随界面语言而变（英文 "Line N" 与其他语言里的数字），
 * 行号行若同时带内容单元格也不能整行跳过。
 */

import { describe, expect, it } from 'vitest';
import { inlineDiffToText } from '../src/results/diffFormat.ts';

const row = (cells: string): string => `<tr>${cells}</tr>`;
const html = (...rows: string[]): string => `<table>${rows.join('')}</table>`;

describe('行号行', () => {
    it('英文 "Line N" 原样识别', () => {
        expect(
            inlineDiffToText(
                html(
                    row('<td colspan="2" class="diff-lineno">Line 5:</td>'),
                    row('<td class="diff-context">same</td>'),
                ),
            ),
        ).toBe('@@ Line 5 @@\n  same');
    });

    it('本地化文案中的数字也识别（第 5 行）', () => {
        expect(
            inlineDiffToText(html(row('<td colspan="2" class="diff-lineno">第 5 行：</td>'))),
        ).toBe('@@ Line 5 @@');
    });

    it('本地化文案中的数字也识别（Línea 12）', () => {
        expect(
            inlineDiffToText(html(row('<td colspan="2" class="diff-lineno">Línea 12</td>'))),
        ).toBe('@@ Line 12 @@');
    });

    it('无数字的行号行不产生输出', () => {
        expect(inlineDiffToText(html(row('<td class="diff-lineno">Line:</td>')))).toBe('');
    });

    it('行号行同时带内容单元格时仍解析内容', () => {
        expect(
            inlineDiffToText(
                html(
                    row(
                        '<td class="diff-lineno">Line 7:</td>' +
                            '<td class="diff-deletedline">old</td>' +
                            '<td class="diff-addedline">new</td>',
                    ),
                ),
            ),
        ).toBe('@@ Line 7 @@\n- old\n+ new');
    });
});

describe('内容行', () => {
    it('context、deleted、added 各自成行', () => {
        expect(
            inlineDiffToText(
                html(
                    row('<td class="diff-context">unchanged</td>'),
                    row(
                        '<td class="diff-deletedline">removed</td>' +
                            '<td class="diff-addedline">added</td>',
                    ),
                ),
            ),
        ).toBe('  unchanged\n- removed\n+ added');
    });

    it('实体与标签被还原', () => {
        expect(
            inlineDiffToText(
                html(row('<td class="diff-context"><span>&lt;div&gt;</span>&amp;</td>')),
            ),
        ).toBe('  <div>&');
    });
});
