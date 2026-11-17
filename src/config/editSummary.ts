import { logger } from '../runtime/logger.ts';

/**
 * 编辑摘要生成设置。
 *
 * 默认值与历史硬编码输出逐字一致，未配置时行为不变。
 */
interface EditSummarySettings {
    /** 为 false 时不附加服务器生成的文案，只用调用方提供的 comment。 */
    readonly attribution: boolean;
    /** 有 comment 时使用的模板，支持 `{comment}` 与 `{tool}`。 */
    readonly template: string;
    /** 无 comment 时使用的模板，支持 `{tool}`；`{comment}` 渲染为空串。 */
    readonly noCommentTemplate: string;
}

const DEFAULT_EDIT_SUMMARY: EditSummarySettings = {
    attribution: true,
    template: '{comment} (via {tool} on MediaWiki MCP Server)',
    noCommentTemplate: 'Automated edit (via {tool} on MediaWiki MCP Server)',
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const readBoolean = (raw: unknown, key: string, fallback: boolean): boolean => {
    if (raw === undefined || raw === null) {
        return fallback;
    }
    if (typeof raw !== 'boolean') {
        throw new Error(`Config error: "${key}" must be a boolean`);
    }
    return raw;
};

const readTemplate = (raw: unknown, key: string, fallback: string): string => {
    if (raw === undefined || raw === null) {
        return fallback;
    }
    if (typeof raw !== 'string' || raw.trim() === '') {
        throw new Error(`Config error: "${key}" must be a non-empty string`);
    }
    return raw;
};

/** 校验并补全 `editSummary`；`null` 与缺失等价。 */
const resolveEditSummary = (raw: unknown): EditSummarySettings => {
    if (raw === undefined || raw === null) {
        return DEFAULT_EDIT_SUMMARY;
    }
    if (!isPlainObject(raw)) {
        throw new Error('Config error: "editSummary" must be an object');
    }
    const attribution = readBoolean(
        raw.attribution,
        'editSummary.attribution',
        DEFAULT_EDIT_SUMMARY.attribution,
    );
    const template = readTemplate(
        raw.template,
        'editSummary.template',
        DEFAULT_EDIT_SUMMARY.template,
    );
    const noCommentTemplate = readTemplate(
        raw.noCommentTemplate,
        'editSummary.noCommentTemplate',
        DEFAULT_EDIT_SUMMARY.noCommentTemplate,
    );
    // 模板漏掉 {comment} 会静默丢弃调用方写的理由，提示而非拒绝。
    if (attribution && !template.includes('{comment}')) {
        logger.warning(
            'editSummary.template has no {comment} placeholder; caller-supplied comments will not appear in edit summaries.',
        );
    }
    if (
        !attribution &&
        (template !== DEFAULT_EDIT_SUMMARY.template ||
            noCommentTemplate !== DEFAULT_EDIT_SUMMARY.noCommentTemplate)
    ) {
        logger.warning('editSummary templates are ignored because attribution is false.');
    }
    return { attribution, template, noCommentTemplate };
};

const PLACEHOLDER_PATTERN = /\{(comment|tool)\}/g;

// 单次函数替换：comment 内出现的 {tool} 或 `$&` 不会被二次展开。
const substitute = (template: string, comment: string, tool: string): string =>
    template.replace(PLACEHOLDER_PATTERN, (_match, name: string) =>
        name === 'comment' ? comment : tool,
    );

/**
 * 生成写入时应带的编辑摘要，空串视为「未提供」。
 *
 * 返回 `undefined` 表示不发送摘要参数，让 MediaWiki 使用自己的默认理由
 * （删除、恢复、保护）或空摘要（编辑）。
 */
const renderEditSummary = (
    settings: EditSummarySettings,
    tool: string,
    comment?: string,
): string | undefined => {
    const given = comment === '' ? undefined : comment;
    if (!settings.attribution) {
        return given;
    }
    const rendered =
        given === undefined
            ? substitute(settings.noCommentTemplate, '', tool)
            : substitute(settings.template, given, tool);
    // 模板可把摘要渲染成空串（如 noCommentTemplate 只有 {comment}），
    // 此时按未提供处理，避免覆盖 wiki 的默认理由。
    return rendered === '' ? undefined : rendered;
};

export { DEFAULT_EDIT_SUMMARY, resolveEditSummary, renderEditSummary };
export type { EditSummarySettings };
