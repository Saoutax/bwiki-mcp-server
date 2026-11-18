/**
 * 请求链参数合并与页面 URL 构造的单元测试。
 *
 * 参数不能再靠字符串拼 "?..."：目标 URL 自带查询串时会被丢弃，值里的
 * `&`、`+`、`?` 也会被当成 URL 语法。页面 URL 的标题段同理，必须转义
 * URL 语法字符，同时保留子页面 `/` 与命名空间 `:`。
 */

import { describe, expect, it } from 'vitest';
import { firstRequest } from '../src/requestChain.ts';
import type { ToolContext } from '../src/runtime/context.ts';
import { buildPageUrl } from '../src/wikis/utils.ts';

const urlOf = (baseUrl: string, params?: Record<string, string>): string =>
    firstRequest(baseUrl, params === undefined ? undefined : { params }).url;

describe('首跳参数合并', () => {
    it('未提供参数时 URL 原样保留', () => {
        expect(urlOf('https://example.org/api.php?old=1')).toBe(
            'https://example.org/api.php?old=1',
        );
    });

    it('空参数对象不改变 URL', () => {
        expect(urlOf('https://example.org/api.php', {})).toBe('https://example.org/api.php');
    });

    it('保留已有查询串并追加新参数', () => {
        const url = new URL(urlOf('https://example.org/api.php?old=1', { action: 'query' }));
        expect(url.searchParams.get('old')).toBe('1');
        expect(url.searchParams.get('action')).toBe('query');
    });

    it('同名参数覆盖而非重复追加', () => {
        const url = new URL(urlOf('https://example.org/api.php?action=edit', { action: 'query' }));
        expect(url.searchParams.getAll('action')).toEqual(['query']);
    });

    it('转义值里的 & + ?', () => {
        const title = 'A&B+C?D';
        const raw = urlOf('https://example.org/api.php', { title });
        // 值必须以转义形式出现，不能把 & 当作参数分隔符。
        expect(raw).not.toContain('A&B+C?D');
        const url = new URL(raw);
        expect(url.searchParams.get('title')).toBe(title);
        expect(url.searchParams.getAll('action')).toEqual([]);
        expect(raw).toContain('A%26B%2BC%3FD');
    });

    it('协议相对地址补为 https 后再合并', () => {
        const url = new URL(urlOf('//example.org/api.php', { action: 'query' }));
        expect(url.protocol).toBe('https:');
        expect(url.searchParams.get('action')).toBe('query');
    });
});

/** siteinfo 缓存命中，故 buildPageUrl 不会发起网络请求。 */
const pageUrl = async (title: string): Promise<string> => {
    const ctx = {
        activeWiki: { get: () => ({ key: 'test-wiki', config: {} }) },
        siteInfoCache: {
            get: () => ({ server: 'https://example.org', articlepath: '/wiki' }),
            isFresh: () => true,
        },
    };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- 测试替身，只实现 resolveSiteInfo 读取的成员
    return buildPageUrl(ctx as unknown as ToolContext, title);
};

describe('页面 URL 构造转义', () => {
    it('空格转为下划线，普通标题直接拼接', async () => {
        expect(await pageUrl('Some Page')).toBe('https://example.org/wiki/Some_Page');
    });

    it('保留子页面的 / 与命名空间的 :', async () => {
        expect(await pageUrl('Template:Foo/Bar')).toBe('https://example.org/wiki/Template:Foo/Bar');
    });

    it('转义 ? & +，使其不再被当作 URL 语法', async () => {
        const url = await pageUrl('A?B&C+D');
        expect(url).toBe('https://example.org/wiki/A%3FB%26C%2BD');
        // 拼进真实 URL 后仍是路径的一部分，而非查询串。
        const parsed = new URL(url);
        expect(parsed.search).toBe('');
        expect(parsed.pathname).toBe('/wiki/A%3FB%26C%2BD');
    });

    it('非 ASCII 字符被转义', async () => {
        expect(await pageUrl('中文')).toBe(
            `https://example.org/wiki/${encodeURIComponent('中文')}`,
        );
    });
});
