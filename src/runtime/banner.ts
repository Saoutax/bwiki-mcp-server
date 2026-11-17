import type { EditSummarySettings } from '../config/editSummary.ts';
import type { ActiveWiki } from '../wikis/activeWiki.ts';
import type { UploadDirs } from '../wikis/uploadDirs.ts';
import type { WikiRegistry } from '../wikis/wikiRegistry.ts';
import { classifyAuthShape } from './authShape.ts';
import { SERVER_VERSION } from './constants.ts';
import { logger } from './logger.ts';

// 标题与版本由打包器注入，不读 server.json。
const serverInfo = {
    title: 'BWiki MCP Server',
    version: SERVER_VERSION,
};

type CreateServerOptions =
    | { transport: 'stdio' }
    | {
          transport: 'http';
          http: {
              host: string;
              port: number;
              allowedHosts?: readonly string[];
              allowedOrigins?: readonly string[];
              maxRequestBody: string;
          };
      };

interface BannerDeps {
    readonly wikiRegistry: WikiRegistry;
    readonly activeWiki: ActiveWiki;
    readonly uploadDirs: UploadDirs;
    // 编辑摘要归属与全局变更标签的配置状态，供运维确认配置已生效。
    readonly editSummary: EditSummarySettings;
    readonly editTags: readonly string[];
    // 托管 OAuth 代理对默认站点启用时，横幅报告 oauth-proxy 认证方式。
    readonly proxyEnabled?: boolean;
}

const emitStartupBanner = (opts: CreateServerOptions, deps: BannerDeps): void => {
    const wikis = deps.wikiRegistry.getAll();
    const data: Record<string, unknown> = {
        event: 'startup',
        version: serverInfo.version,
        transport: opts.transport,
        auth_shape: classifyAuthShape(wikis, opts.transport, deps.proxyEnabled ?? false),
        default_wiki: deps.activeWiki.getDefaultKey(),
        wikis: Object.keys(wikis),
        allow_wiki_management: deps.wikiRegistry.isManagementAllowed(),
        upload_dirs_configured: deps.uploadDirs.list().length > 0,
        edit_summary_attribution: deps.editSummary.attribution,
        edit_tags_configured: deps.editTags.length > 0,
    };
    if (opts.transport === 'http') {
        data.host = opts.http.host;
        data.port = opts.http.port;
        if (opts.http.allowedHosts !== undefined) {
            data.allowed_hosts = opts.http.allowedHosts;
        }
        if (opts.http.allowedOrigins !== undefined) {
            data.allowed_origins = opts.http.allowedOrigins;
        }
        data.max_request_body = opts.http.maxRequestBody;
    }
    logger.info('', data);
};

export { emitStartupBanner };
export type { CreateServerOptions, BannerDeps };
