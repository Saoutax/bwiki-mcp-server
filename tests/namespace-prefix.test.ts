/**
 * 命名空间前缀解析的单元测试。
 *
 * 覆盖：已知/未知前缀、同命名空间与跨命名空间、本地化前缀、
 * 标准英文名兜底，以及 search-page-by-prefix 的前缀拆分。
 */

import { describe, expect, it } from 'vitest';
import type { SiteInfo } from '../src/wikis/siteInfoCache.ts';
import { resolvePrefixForSearch, toNamespaceTitle } from '../src/wikis/titlePrefix.ts';

const siteInfo: SiteInfo = {
    server: 'https://wiki.biligame.com',
    articlepath: '/test',
    sitename: '测试 Wiki',
    // 键由 siteinfo 归一化：小写、空格作下划线。
    namespaceNames: {
        file: 6,
        文件: 6,
        image: 6,
        category: 14,
        分类: 14,
        template: 10,
        模板: 10,
    },
    namespaceCanonical: { 6: 'File', 14: 'Category', 10: 'Template' },
};

/** 断言标题解析成功，返回解析结果。 */
const expectTitle = (result: ReturnType<typeof toNamespaceTitle>) => {
    if ('error' in result) {
        throw new Error(`expected a resolved title, got error: ${result.error}`);
    }
    return result;
};

describe('toNamespaceTitle - File 命名空间', () => {
    it('无前缀时补上 File:', () => {
        expect(expectTitle(toNamespaceTitle('Example.png', 6, siteInfo))).toEqual({
            pageTitle: 'File:Example.png',
            bareName: 'Example.png',
        });
    });

    it('标准英文前缀被去掉', () => {
        expect(expectTitle(toNamespaceTitle('File:Example.png', 6, siteInfo))).toEqual({
            pageTitle: 'File:Example.png',
            bareName: 'Example.png',
        });
    });

    it('前缀大小写不敏感', () => {
        expect(expectTitle(toNamespaceTitle('file:Example.png', 6, siteInfo))).toEqual({
            pageTitle: 'File:Example.png',
            bareName: 'Example.png',
        });
    });

    it('本地化前缀被识别并归一化为标准英文名', () => {
        expect(expectTitle(toNamespaceTitle('文件:Example.png', 6, siteInfo))).toEqual({
            pageTitle: 'File:Example.png',
            bareName: 'Example.png',
        });
    });

    it('别名前缀被识别', () => {
        expect(expectTitle(toNamespaceTitle('Image:Example.png', 6, siteInfo))).toEqual({
            pageTitle: 'File:Example.png',
            bareName: 'Example.png',
        });
    });

    it('跨命名空间前缀报错', () => {
        const result = toNamespaceTitle('Category:Characters', 6, siteInfo);
        expect('error' in result).toBe(true);
        if ('error' in result) {
            expect(result.error).toContain('namespace 14');
            expect(result.error).toContain('File');
        }
    });

    it('未知前缀的冒号属于标题文本', () => {
        expect(expectTitle(toNamespaceTitle('Foo:Bar.png', 6, siteInfo))).toEqual({
            pageTitle: 'File:Foo:Bar.png',
            bareName: 'Foo:Bar.png',
        });
    });

    it('标题前后空白被去掉', () => {
        expect(expectTitle(toNamespaceTitle('  Example.png  ', 6, siteInfo))).toEqual({
            pageTitle: 'File:Example.png',
            bareName: 'Example.png',
        });
    });

    it('首尾空白不影响前缀识别', () => {
        expect(expectTitle(toNamespaceTitle('  File:Example.png  ', 6, siteInfo))).toEqual({
            pageTitle: 'File:Example.png',
            bareName: 'Example.png',
        });
    });

    it('前缀后无标题文本报错', () => {
        const result = toNamespaceTitle('File:', 6, siteInfo);
        expect('error' in result).toBe(true);
    });

    it('只有空白字符的标题报错', () => {
        const result = toNamespaceTitle('   ', 6, siteInfo);
        expect('error' in result).toBe(true);
    });
});

describe('toNamespaceTitle - Category 命名空间', () => {
    it('无前缀时补上 Category:', () => {
        expect(expectTitle(toNamespaceTitle('角色', 14, siteInfo))).toEqual({
            pageTitle: 'Category:角色',
            bareName: '角色',
        });
    });

    it('本地化前缀被归一化', () => {
        expect(expectTitle(toNamespaceTitle('分类:角色', 14, siteInfo))).toEqual({
            pageTitle: 'Category:角色',
            bareName: '角色',
        });
    });

    it('File 前缀用于 Category 工具时报错', () => {
        const result = toNamespaceTitle('File:X.png', 14, siteInfo);
        expect('error' in result).toBe(true);
    });
});

describe('toNamespaceTitle - siteinfo 缺省', () => {
    it('没有命名空间表时仍识别标准英文前缀', () => {
        const bareSite: SiteInfo = { server: 'https://example.org', articlepath: '/w' };
        expect(expectTitle(toNamespaceTitle('File:X.png', 6, bareSite))).toEqual({
            pageTitle: 'File:X.png',
            bareName: 'X.png',
        });
    });

    it('没有命名空间表时本地化前缀按标题文本处理', () => {
        const bareSite: SiteInfo = { server: 'https://example.org', articlepath: '/w' };
        expect(expectTitle(toNamespaceTitle('文件:X.png', 6, bareSite))).toEqual({
            pageTitle: 'File:文件:X.png',
            bareName: '文件:X.png',
        });
    });

    it('siteInfo 为 undefined 时使用标准英文名', () => {
        expect(expectTitle(toNamespaceTitle('X.png', 6, undefined))).toEqual({
            pageTitle: 'File:X.png',
            bareName: 'X.png',
        });
    });
});

describe('resolvePrefixForSearch', () => {
    it('无前缀无显式命名空间时原样返回', () => {
        expect(resolvePrefixForSearch('Example', undefined, siteInfo)).toEqual({
            prefix: 'Example',
        });
    });

    it('前后空白被去掉', () => {
        expect(resolvePrefixForSearch('  Example  ', undefined, siteInfo)).toEqual({
            prefix: 'Example',
        });
    });

    it('无前缀时保留显式命名空间', () => {
        expect(resolvePrefixForSearch('Example', 10, siteInfo)).toEqual({
            prefix: 'Example',
            namespace: 10,
        });
    });

    it('已知前缀被拆成裸前缀与命名空间', () => {
        expect(resolvePrefixForSearch('File:Ab', undefined, siteInfo)).toEqual({
            prefix: 'Ab',
            namespace: 6,
        });
    });

    it('本地化前缀同样被拆开', () => {
        expect(resolvePrefixForSearch('分类:角色', undefined, siteInfo)).toEqual({
            prefix: '角色',
            namespace: 14,
        });
    });

    it('显式命名空间与推断一致时通过', () => {
        expect(resolvePrefixForSearch('File:Ab', 6, siteInfo)).toEqual({
            prefix: 'Ab',
            namespace: 6,
        });
    });

    it('显式命名空间与推断冲突时报错', () => {
        const result = resolvePrefixForSearch('File:Ab', 14, siteInfo);
        expect('error' in result).toBe(true);
        if ('error' in result) {
            expect(result.error).toContain('conflict');
        }
    });

    it('前缀后无文本时报错', () => {
        const result = resolvePrefixForSearch('File:', undefined, siteInfo);
        expect('error' in result).toBe(true);
    });

    it('未知前缀的冒号保留在搜索词里', () => {
        expect(resolvePrefixForSearch('Foo:Bar', undefined, siteInfo)).toEqual({
            prefix: 'Foo:Bar',
        });
    });

    it('未知前缀与显式命名空间并存时保留显式命名空间', () => {
        expect(resolvePrefixForSearch('Foo:Bar', 6, siteInfo)).toEqual({
            prefix: 'Foo:Bar',
            namespace: 6,
        });
    });
});
