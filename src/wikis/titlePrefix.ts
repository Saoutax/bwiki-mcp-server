import type { SiteInfo } from './siteInfoCache.ts';

/**
 * 这些命名空间的标准英文名，作为 siteinfo 未报告命名空间表时的兜底。
 * MediaWiki 始终接受标准英文名，故生成的页面标题无需随站点语言变化。
 */
const CANONICAL_NAMESPACE_NAMES: Readonly<Record<number, string>> = {
    6: 'File',
    14: 'Category',
};

/** 与 MediaWiki 一致：命名空间名不区分大小写，空格与下划线等价。 */
const normalizeNamespaceName = (name: string): string => name.toLowerCase().replace(/ /g, '_');

/** 已知前缀（本地化名、别名、标准英文名）到命名空间 ID 的映射。 */
const namespaceLookup = (siteInfo: SiteInfo | undefined): ReadonlyMap<string, number> => {
    const lookup = new Map<string, number>();
    // siteInfo.namespaceNames 的键本已归一化，这里再归一一遍以防调用方传入未归一化的值。
    for (const [name, namespace] of Object.entries(siteInfo?.namespaceNames ?? {})) {
        lookup.set(normalizeNamespaceName(name), namespace);
    }
    for (const [namespace, name] of Object.entries(siteInfo?.namespaceCanonical ?? {})) {
        lookup.set(normalizeNamespaceName(name), Number(namespace));
    }
    for (const [namespace, name] of Object.entries(CANONICAL_NAMESPACE_NAMES)) {
        const normalized = normalizeNamespaceName(name);
        // 站点自定义的本地化名优先，故已存在时不覆盖。
        if (!lookup.has(normalized)) {
            lookup.set(normalized, Number(namespace));
        }
    }
    return lookup;
};

const canonicalNameFor = (namespace: number, siteInfo: SiteInfo | undefined): string =>
    CANONICAL_NAMESPACE_NAMES[namespace] ??
    siteInfo?.namespaceCanonical?.[namespace] ??
    String(namespace);

/** A title split into its namespace-qualified page title and bare name. */
interface NamespaceTitle {
    /** 带命名空间前缀的完整页面标题，可直接用于 API 查询与链接构造。 */
    pageTitle: string;
    /** 不含命名空间前缀的标题文本。 */
    bareName: string;
}

/** 无法解析时返回的说明，由工具转成 invalid_input。 */
interface TitleResolutionError {
    error: string;
}

/** 标题开头的已知命名空间前缀。 */
interface KnownPrefix {
    namespace: number;
    prefix: string;
}

/**
 * 取出标题开头的已知命名空间前缀。
 *
 * 冒号后可能还有冒号（子页面或标题本身含冒号），只按第一个冒号切分。
 * 前缀不在命名空间表中时返回 undefined，调用方应把整串当作标题文本。
 */
const splitKnownPrefix = (
    title: string,
    siteInfo: SiteInfo | undefined,
): KnownPrefix | undefined => {
    const separator = title.indexOf(':');
    if (separator <= 0) {
        return undefined;
    }
    const prefix = title.slice(0, separator);
    const namespace = namespaceLookup(siteInfo).get(normalizeNamespaceName(prefix));
    return namespace === undefined ? undefined : { namespace, prefix };
};

/**
 * 把用户传入的标题规范成目标命名空间下的页面标题。
 *
 * - 带已知前缀且属于目标命名空间：去掉前缀。
 * - 带已知前缀但属于其他命名空间：报错（避免静默把文件写进别的命名空间）。
 * - 前缀未知：整串视为标题文本，冒号在标题里合法。
 * - 无前缀：补上目标命名空间的标准名。
 */
const toNamespaceTitle = (
    title: string,
    targetNamespace: number,
    siteInfo: SiteInfo | undefined,
): NamespaceTitle | TitleResolutionError => {
    // MediaWiki 忽略标题首尾空白；先归一化，避免 " File:X " 被当成包含未知前缀的标题。
    const normalized = title.trim();
    const known = splitKnownPrefix(normalized, siteInfo);
    if (known !== undefined && known.namespace !== targetNamespace) {
        return {
            error:
                `"${title}" is in namespace ${known.namespace} ("${known.prefix}:"), not the ` +
                `${canonicalNameFor(targetNamespace, siteInfo)} namespace this tool accepts.`,
        };
    }

    const bareName = (
        known === undefined ? normalized : normalized.slice(known.prefix.length + 1)
    ).trim();
    if (bareName === '') {
        return { error: `"${title}" is not a valid page title.` };
    }

    return {
        pageTitle: `${canonicalNameFor(targetNamespace, siteInfo)}:${bareName}`,
        bareName,
    };
};

/** A search prefix split into the bare prefix and the namespace it implies. */
interface SearchPrefix {
    prefix: string;
    namespace?: number;
}

/**
 * 解析 search-page-by-prefix 的前缀：从前缀推断命名空间并去掉它。
 *
 * allpages 的 `apprefix` 与 `apnamespace` 分开传，故带前缀的搜索词必须先拆开。
 * 显式 namespace 与推断结果冲突时报错，而不是静默择一。
 */
const resolvePrefixForSearch = (
    prefix: string,
    namespace: number | undefined,
    siteInfo: SiteInfo | undefined,
): SearchPrefix | TitleResolutionError => {
    const normalized = prefix.trim();
    const known = splitKnownPrefix(normalized, siteInfo);
    if (known === undefined) {
        return namespace === undefined ? { prefix: normalized } : { prefix: normalized, namespace };
    }
    if (namespace !== undefined && namespace !== known.namespace) {
        return {
            error:
                `namespace ${namespace} conflicts with the "${known.prefix}:" prefix, ` +
                `which implies namespace ${known.namespace}.`,
        };
    }

    const barePrefix = normalized.slice(known.prefix.length + 1).trim();
    if (barePrefix === '') {
        return { error: `"${prefix}" has no title text after its namespace prefix.` };
    }
    return { prefix: barePrefix, namespace: known.namespace };
};

export { toNamespaceTitle, resolvePrefixForSearch, CANONICAL_NAMESPACE_NAMES };
export type { NamespaceTitle, SearchPrefix, TitleResolutionError };
