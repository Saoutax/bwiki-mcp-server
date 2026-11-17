/**
 * 编辑摘要与变更标签配置的单元测试。
 *
 * 直接导入 src/，无需先构建。
 *
 * 覆盖点：默认文案与历史硬编码逐字一致、attribution 关闭后的直通语义、
 * 模板占位符替换、非法配置的拒绝、标签规范化。
 */

import type { Mwn } from 'mwn';
import { describe, expect, it } from 'vitest';
import {
    DEFAULT_EDIT_SUMMARY,
    renderEditSummary,
    resolveEditSummary,
} from '../src/config/editSummary.ts';
import { resolveEditTags } from '../src/config/editTags.ts';
import { resolveConfig } from '../src/config/loadConfig.ts';
import type { ToolContext } from '../src/runtime/context.ts';
import { EditServiceImpl } from '../src/services/editService.ts';
import { formatEditComment } from '../src/wikis/utils.ts';

describe('默认文案', () => {
    it('默认设置与历史文案逐字一致', () => {
        expect(DEFAULT_EDIT_SUMMARY).toEqual({
            attribution: true,
            template: '{comment} (via {tool} on MediaWiki MCP Server)',
            noCommentTemplate: 'Automated edit (via {tool} on MediaWiki MCP Server)',
        });
    });

    it('默认设置有 comment 时的输出', () => {
        expect(renderEditSummary(DEFAULT_EDIT_SUMMARY, 'update-page', 'Fix typo')).toBe(
            'Fix typo (via update-page on MediaWiki MCP Server)',
        );
    });

    it('默认设置无 comment 时的输出', () => {
        expect(renderEditSummary(DEFAULT_EDIT_SUMMARY, 'create-page')).toBe(
            'Automated edit (via create-page on MediaWiki MCP Server)',
        );
    });

    it('空串 comment 按未提供处理', () => {
        expect(renderEditSummary(DEFAULT_EDIT_SUMMARY, 'delete-page', '')).toBe(
            'Automated edit (via delete-page on MediaWiki MCP Server)',
        );
    });
});

describe('attribution 开关', () => {
    it('attribution=false 时原样返回 comment', () => {
        const settings = { ...DEFAULT_EDIT_SUMMARY, attribution: false };
        expect(renderEditSummary(settings, 'update-page', 'Fix typo')).toBe('Fix typo');
    });

    it('attribution=false 且无 comment 时返回 undefined', () => {
        const settings = { ...DEFAULT_EDIT_SUMMARY, attribution: false };
        expect(renderEditSummary(settings, 'update-page')).toBeUndefined();
        expect(renderEditSummary(settings, 'update-page', '')).toBeUndefined();
    });

    it('attribution=false 时模板被忽略', () => {
        const settings = {
            attribution: false,
            template: '{comment} [custom]',
            noCommentTemplate: 'custom default',
        };
        expect(renderEditSummary(settings, 'move-page', 'Why')).toBe('Why');
        expect(renderEditSummary(settings, 'move-page')).toBeUndefined();
    });
});

describe('模板替换', () => {
    it('自定义模板替换 {comment} 与 {tool}', () => {
        const settings = {
            attribution: true,
            template: '{tool}:{comment}',
            noCommentTemplate: '{tool}:auto',
        };
        expect(renderEditSummary(settings, 'protect-page', 'Reason')).toBe('protect-page:Reason');
        expect(renderEditSummary(settings, 'protect-page')).toBe('protect-page:auto');
    });

    it('模板中的重复占位符全部替换', () => {
        const settings = {
            attribution: true,
            template: '{comment} / {comment} / {tool}',
            noCommentTemplate: '{tool}',
        };
        expect(renderEditSummary(settings, 'upload-file', 'X')).toBe('X / X / upload-file');
    });

    it('comment 中的 {tool} 不被二次展开', () => {
        const settings = {
            attribution: true,
            template: '{comment} (via {tool})',
            noCommentTemplate: '{tool}',
        };
        expect(renderEditSummary(settings, 'update-page', 'literal {tool} here')).toBe(
            'literal {tool} here (via update-page)',
        );
    });

    it('comment 中的 $& 不被当作替换引用', () => {
        const settings = {
            attribution: true,
            template: '{comment} (via {tool})',
            noCommentTemplate: '{tool}',
        };
        expect(renderEditSummary(settings, 'update-page', 'cost $& more')).toBe(
            'cost $& more (via update-page)',
        );
    });

    it('未知占位符原样保留', () => {
        const settings = {
            attribution: true,
            template: '{wiki} {comment} {unknown}',
            noCommentTemplate: '{wiki}',
        };
        expect(renderEditSummary(settings, 'update-page', 'X')).toBe('{wiki} X {unknown}');
        expect(renderEditSummary(settings, 'update-page')).toBe('{wiki}');
    });

    it('渲染结果为空串时返回 undefined', () => {
        const settings = {
            attribution: true,
            template: '{comment}',
            noCommentTemplate: '{comment}',
        };
        expect(renderEditSummary(settings, 'update-page')).toBeUndefined();
    });

    it('不含 {comment} 的模板只输出常量', () => {
        const settings = {
            attribution: true,
            template: '[bot]',
            noCommentTemplate: '[bot]',
        };
        expect(renderEditSummary(settings, 'update-page', 'ignored')).toBe('[bot]');
    });
});

describe('editSummary 校验', () => {
    it('editSummary 缺失或 null 使用默认值', () => {
        expect(resolveEditSummary(undefined)).toEqual(DEFAULT_EDIT_SUMMARY);
        expect(resolveEditSummary(null)).toEqual(DEFAULT_EDIT_SUMMARY);
    });

    it('editSummary 自定义值被接受', () => {
        expect(
            resolveEditSummary({
                attribution: false,
                template: '{comment} [x]',
                noCommentTemplate: 'auto',
            }),
        ).toEqual({ attribution: false, template: '{comment} [x]', noCommentTemplate: 'auto' });
    });

    it('editSummary 非法值被拒绝', () => {
        expect(() => resolveEditSummary([])).toThrow(
            /^Config error: "editSummary" must be an object$/,
        );
        expect(() => resolveEditSummary('x')).toThrow(
            /^Config error: "editSummary" must be an object$/,
        );
        expect(() => resolveEditSummary({ attribution: 'true' })).toThrow(
            /^Config error: "editSummary\.attribution" must be a boolean$/,
        );
        expect(() => resolveEditSummary({ template: '' })).toThrow(
            /^Config error: "editSummary\.template" must be a non-empty string$/,
        );
        expect(() => resolveEditSummary({ template: 42 })).toThrow(
            /^Config error: "editSummary\.template" must be a non-empty string$/,
        );
        expect(() => resolveEditSummary({ noCommentTemplate: '   ' })).toThrow(
            /^Config error: "editSummary\.noCommentTemplate" must be a non-empty string$/,
        );
    });
});

describe('editTags 校验', () => {
    it('editTags 缺失或 null 得到空数组', () => {
        expect(resolveEditTags(undefined)).toEqual([]);
        expect(resolveEditTags(null)).toEqual([]);
    });

    it('editTags 会 trim 并去重', () => {
        expect(resolveEditTags([' bwiki-mcp ', 'bwiki-mcp', 'bot edit'])).toEqual([
            'bwiki-mcp',
            'bot edit',
        ]);
    });

    it('editTags 非法值被拒绝', () => {
        expect(() => resolveEditTags('tag')).toThrow(
            /^Config error: "editTags" must be an array of strings$/,
        );
        expect(() => resolveEditTags([1])).toThrow(
            /^Config error: "editTags" entries must be strings$/,
        );
        expect(() => resolveEditTags([''])).toThrow(
            /^Config error: "editTags" entries must be non-empty strings$/,
        );
    });
});

describe('resolveConfig 集成', () => {
    it('resolveConfig 未配置时使用默认摘要与空标签', () => {
        const config = resolveConfig({ wikis: ['ci-wiki'] });
        expect(config.editSummary).toEqual(DEFAULT_EDIT_SUMMARY);
        expect(config.editTags).toEqual([]);
    });

    it('resolveConfig 读取 editSummary 与 editTags', () => {
        const config = resolveConfig({
            wikis: ['ci-wiki'],
            editSummary: { attribution: false },
            editTags: ['bwiki-mcp', 'bwiki-mcp'],
        });
        expect(config.editSummary.attribution).toBe(false);
        expect(config.editSummary.template).toBe(DEFAULT_EDIT_SUMMARY.template);
        expect(config.editTags).toEqual(['bwiki-mcp']);
    });

    it('resolveConfig 传递非法 editSummary 错误', () => {
        expect(() => resolveConfig({ wikis: ['ci-wiki'], editSummary: true })).toThrow(
            /^Config error: "editSummary" must be an object$/,
        );
    });
});

describe('接线检查', () => {
    it('formatEditComment 读取 ctx.editSummary', () => {
        // 只用到 ctx.editSummary，测试替身不必构造完整 ToolContext。
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- 测试替身
        const ctx = { editSummary: DEFAULT_EDIT_SUMMARY } as unknown as ToolContext;
        expect(formatEditComment(ctx, 'update-page', 'Fix typo')).toBe(
            'Fix typo (via update-page on MediaWiki MCP Server)',
        );
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- 测试替身
        const silent = {
            editSummary: { ...DEFAULT_EDIT_SUMMARY, attribution: false },
        } as unknown as ToolContext;
        expect(formatEditComment(silent, 'update-page', 'Fix typo')).toBe('Fix typo');
        expect(formatEditComment(silent, 'update-page')).toBeUndefined();
    });

    it('EditService.applyTags 注入全局标签', () => {
        expect(new EditServiceImpl(['bwiki-mcp']).applyTags({ bot: true })).toEqual({
            bot: true,
            tags: ['bwiki-mcp'],
        });
        expect(new EditServiceImpl([]).applyTags({ bot: true })).toEqual({ bot: true });
    });

    it('EditService.submit 注入全局标签', async () => {
        const sent: Record<string, unknown>[] = [];
        // 模拟 mwn.request：把参数透传回来，便于断言。
        const fakeMwn = {
            getCsrfToken: async () => 'token',
            request: async (params: Record<string, unknown>) => {
                sent.push(params);
                return params;
            },
        } as unknown as Mwn;
        await new EditServiceImpl(['bwiki-mcp']).submit(fakeMwn, { action: 'protect', title: 'X' });
        expect(sent[0]?.tags).toEqual(['bwiki-mcp']);
        expect(sent[0]?.token).toBe('token');
        expect(sent[0]?.formatversion).toBe('2');
    });

    it('EditService 无标签时不发送 tags', async () => {
        const sent: Record<string, unknown>[] = [];
        const fakeMwn = {
            getCsrfToken: async () => 'token',
            request: async (params: Record<string, unknown>) => {
                sent.push(params);
                return params;
            },
        } as unknown as Mwn;
        await new EditServiceImpl([]).submit(fakeMwn, { action: 'protect', title: 'X' });
        expect(Object.hasOwn(sent[0], 'tags')).toBe(false);
    });
});
