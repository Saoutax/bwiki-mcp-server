import * as fs from 'fs';
import { homedir } from 'os';
import * as path from 'path';
import { errorMessage } from '../errors/isErrnoException.ts';
import { logger } from '../runtime/logger.ts';
import { wikiKeyProblem, wikiKeyProblemMessage } from '../runtime/wikiKey.ts';
import {
    DEFAULT_EDIT_SUMMARY,
    resolveEditSummary,
    type EditSummarySettings,
} from './editSummary.ts';
import { resolveEditTags } from './editTags.ts';

/** BWiki 农场的唯一 host，不可配置。 */
const FARM_HOST = 'wiki.biligame.com';
const FARM_ORIGIN = `https://${FARM_HOST}`;

interface WikiConfig {
    /** $wgSitename */
    sitename: string;
    /** $wgServer */
    server: string;
    /** $wgArticlePath */
    articlepath: string;
    /** $wgScriptPath */
    scriptpath: string;
    /** OAuth 消费方 token */
    token?: string | ExecSecret | null;
    /** Special:BotPasswords 用户名 */
    username?: string | ExecSecret | null;
    /** Special:BotPasswords 密码 */
    password?: string | ExecSecret | null;
    /** OAuth 2.0 客户端 ID */
    oauth2ClientId?: string | null;
    /** 站点是否必须登录才能访问 */
    private?: boolean;
    /** 为 true 时拒绝该站点的写操作 */
    readOnly?: boolean;
    /** bilibili 会话文件路径，未设则用平台默认 */
    passportSessionFile?: string | null;
}

/** 可对外发布的 wiki 字段。用 Pick 而非 Omit，新增字段不会默认被发布。 */
type PublicWikiConfig = Pick<
    WikiConfig,
    'sitename' | 'server' | 'articlepath' | 'scriptpath' | 'private' | 'readOnly'
>;

interface Config {
    wikis: { [key: string]: WikiConfig };
    defaultWiki: string;
    /**
     * 为 false 时禁用站点管理工具。
     */
    allowWikiManagement?: boolean;
    /**
     * 上传工具可读取的绝对路径目录，空表示禁用上传。
     */
    uploadDirs: readonly string[];
    /**
     * 编辑摘要生成方式，未配置时使用内置文案。
     */
    editSummary: EditSummarySettings;
    /**
     * 写入时附加的 MediaWiki 变更标签，全局作用于所有已配置站点。
     */
    editTags: readonly string[];
}

const defaultConfig: Config = {
    defaultWiki: '',
    uploadDirs: [],
    editSummary: DEFAULT_EDIT_SUMMARY,
    editTags: [],
    wikis: {},
};

/**
 * bilibili 会话文件的默认位置，可由 `passportSessionFile` 覆盖。
 */
const DEFAULT_SESSION_FILE =
    process.platform === 'win32'
        ? path.join(
              process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming'),
              'bwiki-mcp-server',
              'session.json',
          )
        : path.join(homedir(), '.config', 'bwiki-mcp-server', 'session.json');

/**
 * 由执行外部命令得到取值的凭证字段。
 * 配置加载时校验，首次使用该站点时才真正执行命令，
 * 见 src/wikis/execSecret.ts。
 */
interface ExecSecret {
    exec: {
        command: string;
        args: string[];
    };
}

/** 凭证字段是否已配置，不实际解析 exec 来源的密钥。 */
const isCredentialConfigured = (value: string | ExecSecret | null | undefined): boolean => {
    if (typeof value === 'string') {
        return value.length > 0;
    }
    return value !== null && value !== undefined;
};

const configPath = process.env.CONFIG || 'config.json';

const replaceEnvVars = (value: string): string =>
    value.replace(/\$\{([^}]+)\}/g, (match, envVar: string) => {
        const envValue = process.env[envVar];
        return envValue !== undefined ? envValue : match;
    });

/**
 * 拆分 `MCP_UPLOAD_DIRS`。
 *
 * Windows 的路径本身含盘符冒号，故分隔符必须用 `;`（即 `path.delimiter`）；
 * 其他平台沿用 `:`。
 */
const splitUploadDirList = (
    raw: string,
    platform: NodeJS.Platform = process.platform,
): string[] => {
    const delimiter = platform === 'win32' ? ';' : ':';
    return raw
        .split(delimiter)
        .map(entry => entry.trim())
        .filter(entry => entry !== '');
};

const resolveUploadDirs = (rawFromConfig: unknown): readonly string[] => {
    const fromConfig: string[] = [];
    if (rawFromConfig !== undefined) {
        if (!Array.isArray(rawFromConfig)) {
            throw new Error('Config error: uploadDirs must be an array of strings');
        }
        for (const entry of rawFromConfig) {
            if (typeof entry !== 'string') {
                throw new Error('Config error: uploadDirs entries must be strings');
            }
            if (!path.isAbsolute(entry)) {
                throw new Error(`Config error: uploadDirs entry "${entry}" must be absolute`);
            }
            fromConfig.push(entry);
        }
    }

    const envRaw = process.env.MCP_UPLOAD_DIRS;
    const fromEnv: string[] = [];
    if (envRaw) {
        for (const entry of splitUploadDirList(envRaw)) {
            if (!path.isAbsolute(entry)) {
                throw new Error(`Config error: MCP_UPLOAD_DIRS entry "${entry}" must be absolute`);
            }
            fromEnv.push(entry);
        }
    }

    const canonicalised: string[] = [];
    for (const raw of [...fromEnv, ...fromConfig]) {
        let canonical: string;
        try {
            canonical = fs.realpathSync(raw);
        } catch (err) {
            throw new Error(
                `Config error: upload directory "${raw}" cannot be resolved (${errorMessage(err)}). Ensure the directory exists before starting the server.`,
            );
        }
        if (!canonicalised.includes(canonical)) {
            canonicalised.push(canonical);
        }
    }
    return canonicalised;
};

const resolveConfig = (parsed: unknown): Config => {
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('Config error: config.json must be an object');
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- post-JSON.parse boundary; ajv-validated WikiConfig parsing is a separate follow-up
    const p = parsed as Record<string, unknown>;
    const allowWikiManagement =
        typeof p.allowWikiManagement === 'boolean' ? p.allowWikiManagement : undefined;
    const uploadDirs = resolveUploadDirs(p.uploadDirs);
    const editSummary = resolveEditSummary(p.editSummary);
    const editTags = resolveEditTags(p.editTags);

    const codes = readWikiCodes(p.wikis);
    const wikis: Record<string, WikiConfig> = {};
    for (const code of codes) {
        const problem = wikiKeyProblem(code);
        if (problem !== undefined) {
            throw new Error(`Config error: wiki "${code}" ${wikiKeyProblemMessage(problem)}`);
        }
        wikis[code] = wikiFromCode(code);
    }
    // 第一个即默认站点；为空则由启动检查拒绝。
    const defaultWiki = codes[0] ?? '';
    applyOAuth2ClientIdOverride(wikis, defaultWiki);
    return { defaultWiki, wikis, allowWikiManagement, uploadDirs, editSummary, editTags };
};

/**
 * 读取 `wikis` 中的站点代号列表。只接受代号，也接受单个字符串。
 */
const readWikiCodes = (raw: unknown): string[] => {
    if (raw === undefined || raw === null) {
        return [];
    }
    if (typeof raw === 'string') {
        return [replaceEnvVars(raw)].map(c => c.trim()).filter(Boolean);
    }
    if (!Array.isArray(raw)) {
        throw new Error(
            'Config error: "wikis" must be an array of wiki codes, e.g. ["somewiki", "anotherwiki"].',
        );
    }
    return raw
        .map(entry => {
            if (typeof entry !== 'string') {
                throw new Error(
                    `Config error: "wikis" entries must be strings (wiki codes), got ${JSON.stringify(entry)}.`,
                );
            }
            return replaceEnvVars(entry).trim();
        })
        .filter(Boolean);
};

/**
 * 由站点代号展开为完整配置。
 *
 * `scriptpath` 必须为空：BWiki 无 /w 段，填了会拼出 /<code>/<code>/api.php 而 404。
 * `sitename` 留空，启动时从 siteinfo 读取。
 */
const wikiFromCode = (code: string): WikiConfig => ({
    sitename: '',
    server: `${FARM_ORIGIN}/${code}`,
    articlepath: `/${code}`,
    scriptpath: '',
    private: false,
});

/** `MCP_OAUTH2_CLIENT_ID` 覆盖默认站点的 `oauth2ClientId`。 */
const applyOAuth2ClientIdOverride = (
    wikis: Record<string, WikiConfig>,
    defaultWiki: string,
): void => {
    const fromEnv = process.env.MCP_OAUTH2_CLIENT_ID?.trim();
    if (fromEnv && wikis[defaultWiki]) {
        wikis[defaultWiki].oauth2ClientId = fromEnv;
    }
};

const loadConfigFromFile = (): Config => {
    if (!fs.existsSync(configPath)) {
        // 无内置默认站点，返回空配置交由启动检查拒绝。
        logger.error(
            `Config file not found at "${configPath}". Copy config.example.json to config.json and name the wikis you want to use, or point CONFIG at an existing file. A relative path resolves against the server's working directory.`,
        );
        return { ...defaultConfig, uploadDirs: resolveUploadDirs(undefined) };
    }
    const rawData = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(rawData);
    return resolveConfig(parsed);
};

export {
    FARM_HOST,
    FARM_ORIGIN,
    defaultConfig,
    DEFAULT_SESSION_FILE,
    isCredentialConfigured,
    loadConfigFromFile,
    resolveConfig,
    splitUploadDirList,
};
export type { WikiConfig, PublicWikiConfig, Config, ExecSecret };
