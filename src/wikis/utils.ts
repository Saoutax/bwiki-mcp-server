import { renderEditSummary } from '../config/editSummary.ts';
import type { ToolContext } from '../runtime/context.ts';
import { resolveSiteInfo } from './siteInfo.ts';

const buildPageUrl = async (ctx: ToolContext, title: string): Promise<string> => {
    const { key } = ctx.activeWiki.get();
    const { server, articlepath } = await resolveSiteInfo(ctx, key);
    // MediaWiki 习惯：空格转为下划线。用 encodeURIComponent 而非 encodeURI：
    // 后者保留 `?`、`&`、`+`，会把标题里的这些字符变成 URL 语法。
    // 再单独恢复 '/' 与 ':'，保留子页面与命名空间前缀。
    const encoded = encodeURIComponent(title.replace(/ /g, '_'));
    const pagePath = encoded.replace(/%2F/gi, '/').replace(/%3A/gi, ':');
    return `${server}${articlepath}/${pagePath}`;
};

/**
 * 写入应带的编辑摘要，为空时返回 `undefined`。
 * 摘要缺失与空串含义不同，MediaWiki 仅在参数缺失时写入自己的删除理由。
 */
const formatEditComment = (ctx: ToolContext, tool: string, comment?: string): string | undefined =>
    renderEditSummary(ctx.editSummary, tool, comment);

export { buildPageUrl, formatEditComment };
