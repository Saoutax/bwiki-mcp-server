/**
 * 编辑摘要与变更标签配置的离线检查。
 *
 * 纯函数检查，不需要会话、网络或 config.json，只针对构建产物运行：
 *
 *     pnpm run build && node scripts/probe-edit-summary.mjs
 *
 * 覆盖点：默认文案与历史硬编码逐字一致、attribution 关闭后的直通语义、
 * 模板占位符替换、非法配置的拒绝、标签规范化。
 */

import assert from 'node:assert/strict';
import {
    DEFAULT_EDIT_SUMMARY,
    renderEditSummary,
    resolveEditSummary,
} from '../dist/config/editSummary.js';
import { resolveEditTags } from '../dist/config/editTags.js';
import { resolveConfig } from '../dist/config/loadConfig.js';
import { EditServiceImpl } from '../dist/services/editService.js';
import { formatEditComment } from '../dist/wikis/utils.js';

const results = [];
const report = (name, fn) => {
    try {
        fn();
        results.push({ name, ok: true });
        console.log(`PASS  ${name}`);
    } catch (err) {
        results.push({ name, ok: false });
        console.log(`FAIL  ${name}`);
        console.log(`      ${err.message}`);
    }
};

const reportAsync = async (name, fn) => {
    try {
        await fn();
        results.push({ name, ok: true });
        console.log(`PASS  ${name}`);
    } catch (err) {
        results.push({ name, ok: false });
        console.log(`FAIL  ${name}`);
        console.log(`      ${err.message}`);
    }
};

const render = (settings, tool, comment) => renderEditSummary(settings, tool, comment);

const configError = pattern => err =>
    err instanceof Error && pattern.test(err.message) && err.message.startsWith('Config error:');

// ------------------------------------------------------------ 默认文案

report('默认设置与历史文案逐字一致', () => {
    assert.deepEqual(DEFAULT_EDIT_SUMMARY, {
        attribution: true,
        template: '{comment} (via {tool} on MediaWiki MCP Server)',
        noCommentTemplate: 'Automated edit (via {tool} on MediaWiki MCP Server)',
    });
});

report('默认设置有 comment 时的输出', () => {
    assert.equal(
        render(DEFAULT_EDIT_SUMMARY, 'update-page', 'Fix typo'),
        'Fix typo (via update-page on MediaWiki MCP Server)',
    );
});

report('默认设置无 comment 时的输出', () => {
    assert.equal(
        render(DEFAULT_EDIT_SUMMARY, 'create-page'),
        'Automated edit (via create-page on MediaWiki MCP Server)',
    );
});

report('空串 comment 按未提供处理', () => {
    assert.equal(
        render(DEFAULT_EDIT_SUMMARY, 'delete-page', ''),
        'Automated edit (via delete-page on MediaWiki MCP Server)',
    );
});

// ------------------------------------------------------------ attribution 开关

report('attribution=false 时原样返回 comment', () => {
    const settings = { ...DEFAULT_EDIT_SUMMARY, attribution: false };
    assert.equal(render(settings, 'update-page', 'Fix typo'), 'Fix typo');
});

report('attribution=false 且无 comment 时返回 undefined', () => {
    const settings = { ...DEFAULT_EDIT_SUMMARY, attribution: false };
    assert.equal(render(settings, 'update-page'), undefined);
    assert.equal(render(settings, 'update-page', ''), undefined);
});

report('attribution=false 时模板被忽略', () => {
    const settings = {
        attribution: false,
        template: '{comment} [custom]',
        noCommentTemplate: 'custom default',
    };
    assert.equal(render(settings, 'move-page', 'Why'), 'Why');
    assert.equal(render(settings, 'move-page'), undefined);
});

// ------------------------------------------------------------ 模板替换

report('自定义模板替换 {comment} 与 {tool}', () => {
    const settings = {
        attribution: true,
        template: '{tool}:{comment}',
        noCommentTemplate: '{tool}:auto',
    };
    assert.equal(render(settings, 'protect-page', 'Reason'), 'protect-page:Reason');
    assert.equal(render(settings, 'protect-page'), 'protect-page:auto');
});

report('模板中的重复占位符全部替换', () => {
    const settings = {
        attribution: true,
        template: '{comment} / {comment} / {tool}',
        noCommentTemplate: '{tool}',
    };
    assert.equal(render(settings, 'upload-file', 'X'), 'X / X / upload-file');
});

report('comment 中的 {tool} 不被二次展开', () => {
    const settings = {
        attribution: true,
        template: '{comment} (via {tool})',
        noCommentTemplate: '{tool}',
    };
    assert.equal(
        render(settings, 'update-page', 'literal {tool} here'),
        'literal {tool} here (via update-page)',
    );
});

report('comment 中的 $& 不被当作替换引用', () => {
    const settings = {
        attribution: true,
        template: '{comment} (via {tool})',
        noCommentTemplate: '{tool}',
    };
    assert.equal(render(settings, 'update-page', 'cost $& more'), 'cost $& more (via update-page)');
});

report('未知占位符原样保留', () => {
    const settings = {
        attribution: true,
        template: '{wiki} {comment} {unknown}',
        noCommentTemplate: '{wiki}',
    };
    assert.equal(render(settings, 'update-page', 'X'), '{wiki} X {unknown}');
    assert.equal(render(settings, 'update-page'), '{wiki}');
});

report('渲染结果为空串时返回 undefined', () => {
    const settings = {
        attribution: true,
        template: '{comment}',
        noCommentTemplate: '{comment}',
    };
    assert.equal(render(settings, 'update-page'), undefined);
});

report('不含 {comment} 的模板只输出常量', () => {
    const settings = {
        attribution: true,
        template: '[bot]',
        noCommentTemplate: '[bot]',
    };
    assert.equal(render(settings, 'update-page', 'ignored'), '[bot]');
});

// ------------------------------------------------------------ editSummary 校验

report('editSummary 缺失或 null 使用默认值', () => {
    assert.deepEqual(resolveEditSummary(undefined), DEFAULT_EDIT_SUMMARY);
    assert.deepEqual(resolveEditSummary(null), DEFAULT_EDIT_SUMMARY);
});

report('editSummary 自定义值被接受', () => {
    assert.deepEqual(
        resolveEditSummary({
            attribution: false,
            template: '{comment} [x]',
            noCommentTemplate: 'auto',
        }),
        { attribution: false, template: '{comment} [x]', noCommentTemplate: 'auto' },
    );
});

report('editSummary 非法值被拒绝', () => {
    assert.throws(() => resolveEditSummary([]), configError(/"editSummary" must be an object/));
    assert.throws(() => resolveEditSummary('x'), configError(/"editSummary" must be an object/));
    assert.throws(
        () => resolveEditSummary({ attribution: 'true' }),
        configError(/"editSummary\.attribution" must be a boolean/),
    );
    assert.throws(
        () => resolveEditSummary({ template: '' }),
        configError(/"editSummary\.template" must be a non-empty string/),
    );
    assert.throws(
        () => resolveEditSummary({ template: 42 }),
        configError(/"editSummary\.template" must be a non-empty string/),
    );
    assert.throws(
        () => resolveEditSummary({ noCommentTemplate: '   ' }),
        configError(/"editSummary\.noCommentTemplate" must be a non-empty string/),
    );
});

// ------------------------------------------------------------ editTags 校验

report('editTags 缺失或 null 得到空数组', () => {
    assert.deepEqual(resolveEditTags(undefined), []);
    assert.deepEqual(resolveEditTags(null), []);
});

report('editTags 会 trim 并去重', () => {
    assert.deepEqual(resolveEditTags([' bwiki-mcp ', 'bwiki-mcp', 'bot edit']), [
        'bwiki-mcp',
        'bot edit',
    ]);
});

report('editTags 非法值被拒绝', () => {
    assert.throws(() => resolveEditTags('tag'), configError(/"editTags" must be an array/));
    assert.throws(() => resolveEditTags([1]), configError(/"editTags" entries must be strings/));
    assert.throws(() => resolveEditTags(['']), configError(/"editTags" entries must be non-empty/));
});

// ------------------------------------------------------------ resolveConfig 集成

report('resolveConfig 未配置时使用默认摘要与空标签', () => {
    const config = resolveConfig({ wikis: ['ci-wiki'] });
    assert.deepEqual(config.editSummary, DEFAULT_EDIT_SUMMARY);
    assert.deepEqual(config.editTags, []);
});

report('resolveConfig 读取 editSummary 与 editTags', () => {
    const config = resolveConfig({
        wikis: ['ci-wiki'],
        editSummary: { attribution: false },
        editTags: ['bwiki-mcp', 'bwiki-mcp'],
    });
    assert.equal(config.editSummary.attribution, false);
    assert.equal(config.editSummary.template, DEFAULT_EDIT_SUMMARY.template);
    assert.deepEqual(config.editTags, ['bwiki-mcp']);
});

report('resolveConfig 传递非法 editSummary 错误', () => {
    assert.throws(
        () => resolveConfig({ wikis: ['ci-wiki'], editSummary: true }),
        configError(/"editSummary" must be an object/),
    );
});

// ------------------------------------------------------------ 接线检查

report('formatEditComment 读取 ctx.editSummary', () => {
    const ctx = { editSummary: DEFAULT_EDIT_SUMMARY };
    assert.equal(
        formatEditComment(ctx, 'update-page', 'Fix typo'),
        'Fix typo (via update-page on MediaWiki MCP Server)',
    );
    const silent = { editSummary: { ...DEFAULT_EDIT_SUMMARY, attribution: false } };
    assert.equal(formatEditComment(silent, 'update-page', 'Fix typo'), 'Fix typo');
    assert.equal(formatEditComment(silent, 'update-page'), undefined);
});

report('EditService.applyTags 注入全局标签', () => {
    assert.deepEqual(new EditServiceImpl(['bwiki-mcp']).applyTags({ bot: true }), {
        bot: true,
        tags: ['bwiki-mcp'],
    });
    assert.deepEqual(new EditServiceImpl([]).applyTags({ bot: true }), { bot: true });
});

await reportAsync('EditService.submit 注入全局标签', async () => {
    const sent = [];
    const fakeMwn = {
        getCsrfToken: async () => 'token',
        // 模拟 mwn.request：把参数透传回来，便于断言。
        request: async params => {
            sent.push(params);
            return params;
        },
    };
    const service = new EditServiceImpl(['bwiki-mcp']);
    await service.submit(fakeMwn, { action: 'protect', title: 'X' });
    assert.deepEqual(sent[0].tags, ['bwiki-mcp']);
    assert.equal(sent[0].token, 'token');
    assert.equal(sent[0].formatversion, '2');
});

await reportAsync('EditService 无标签时不发送 tags', async () => {
    const sent = [];
    const fakeMwn = {
        getCsrfToken: async () => 'token',
        request: async params => {
            sent.push(params);
            return params;
        },
    };
    await new EditServiceImpl([]).submit(fakeMwn, { action: 'protect', title: 'X' });
    assert.equal(Object.hasOwn(sent[0], 'tags'), false);
});

// ------------------------------------------------------------ summary

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) {
    console.log('失败项:');
    for (const f of failed) {
        console.log(`  - ${f.name}`);
    }
}
process.exit(failed.length > 0 ? 1 : 0);
