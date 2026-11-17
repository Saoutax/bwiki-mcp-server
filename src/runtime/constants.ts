/** 运行时常量。 */

const WIKI_RESOURCE_URI_PREFIX = 'mcp://wikis/';

const SERVER_NAME = 'bwiki-mcp-server';

/** 版本号，构建时由打包器注入。 */
const SERVER_VERSION: string = process.env.BWIKI_MCP_VERSION ?? '0.1.0';

/**
 * Chrome 桌面版 User-Agent。
 *
 * 自报项目名会被 EdgeOne 判定为自动化而提高拦截概率，故采用浏览器 UA。
 */
const CHROME_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const resolveUserAgent = (env: NodeJS.ProcessEnv): string =>
    env.MCP_USER_AGENT?.trim() || CHROME_USER_AGENT;

/**
 * 由 API 地址推导 Referer，指向站点自身。
 *
 * 不带 Referer 的裸 API 请求更接近爬虫特征。
 */
const refererFor = (apiUrl: string): string | undefined => {
    try {
        const url = new URL(apiUrl);
        // BWiki 的 api.php 位于站点根（…/<wiki>/api.php），
        // 故取其上两级目录作为 Referer。
        const dir = url.pathname.replace(/[^/]*$/, '');
        return `${url.origin}${dir}`;
    } catch {
        return undefined;
    }
};

const USER_AGENT: string = resolveUserAgent(process.env);

export {
    WIKI_RESOURCE_URI_PREFIX,
    SERVER_NAME,
    SERVER_VERSION,
    CHROME_USER_AGENT,
    USER_AGENT,
    resolveUserAgent,
    refererFor,
};
