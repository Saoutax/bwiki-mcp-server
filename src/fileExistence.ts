import type { ApiPage, Mwn } from 'mwn';
import type { SiteInfo } from './wikis/siteInfoCache.ts';
import { toNamespaceTitle } from './wikis/titlePrefix.ts';

class FileNotFoundError extends Error {
    public constructor(public readonly title: string) {
        super(`File "${title}" does not exist.`);
        this.name = 'FileNotFoundError';
    }
}

/** 标题解析失败或 API 判定标题非法；调用方据此返回 invalid_input 而非 not_found。 */
class InvalidFileTitleError extends Error {
    public constructor(public readonly title: string) {
        super(`"${title}" is not a valid page title.`);
        this.name = 'InvalidFileTitleError';
    }
}

const assertFileExists = async (
    mwn: Mwn,
    title: string,
    siteInfo: SiteInfo | undefined,
): Promise<void> => {
    const resolvedTitle = toNamespaceTitle(title, 6, siteInfo);
    if ('error' in resolvedTitle) {
        throw new InvalidFileTitleError(title);
    }

    const response = await mwn.request({
        action: 'query',
        titles: resolvedTitle.pageTitle,
        prop: 'imageinfo',
        iiprop: 'timestamp',
        formatversion: '2',
    });

    const page = (response as { query?: { pages?: ApiPage[] } }).query?.pages?.[0];

    // invalid 必须早于 missing 判断：MediaWiki 对非法标题同时置两个标记。
    if (page?.invalid === true) {
        throw new InvalidFileTitleError(title);
    }
    if (!page || page.missing || !page.imageinfo || page.imageinfo.length === 0) {
        throw new FileNotFoundError(title);
    }
};

export { FileNotFoundError, InvalidFileTitleError, assertFileExists };
