/**
 * 上传大小上限的纯函数集合。
 *
 * 站点上限来自 siteinfo 的 `general.maxuploadsize`；服务端内存上限来自
 * `MCP_UPLOAD_MAX_BYTES`（见 httpFetch.ts）。两者谁更小谁生效：
 * 服务器更小时转交 wiki 侧复制上传，站点更小时直接判定文件过大。
 * 本模块不读写状态，便于单独测试边界。
 */

/**
 * 从 siteinfo 的 `general.maxuploadsize` 读出有限正整数，否则返回 undefined。
 *
 * MediaWiki 用 0 或负数表示站点未设上限，故视同未报告；非整数与非有限值
 * （部分站点会以字符串给出）同样忽略，避免用无效上限误拒上传。
 */
const readMaxUploadSize = (raw: unknown): number | undefined => {
    const value = typeof raw === 'string' ? Number(raw) : raw;
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
        return undefined;
    }
    return value;
};

/**
 * 文件是否超出站点上限。站点未报告上限时不做预检，故总是返回 false。
 */
const exceedsSiteUploadLimit = (size: number, siteMax: number | undefined): boolean =>
    siteMax !== undefined && size > siteMax;

/**
 * 服务端内存上限与站点上限中的较小者，作为抓取远程 URL 时允许的字节数。
 * 站点未报告上限时只用服务端上限。
 */
const resolveEffectiveMaxBytes = (serverMax: number, siteMax: number | undefined): number =>
    siteMax === undefined ? serverMax : Math.min(serverMax, siteMax);

/** 人类可读的字节数，用于错误提示。 */
const formatByteSize = (bytes: number): string => {
    if (bytes >= 1024 * 1024) {
        return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
    }
    if (bytes >= 1024) {
        return `${(bytes / 1024).toFixed(1)} KiB`;
    }
    return `${bytes} B`;
};

/**
 * 文件超出站点上限时的提示：给出实际字节数与站点上限，并建议换更小的文件，
 * 避免调用方原样重试同一份内容。小写开头，便于调用方在前面补上下文。
 */
const siteUploadLimitMessage = (size: number, siteMax: number): string =>
    `the file is ${size} bytes (${formatByteSize(size)}), over this wiki's upload limit of ` +
    `${siteMax} bytes (${formatByteSize(siteMax)}). ` +
    'Upload a smaller file (compress it or reduce its dimensions).';

export {
    readMaxUploadSize,
    exceedsSiteUploadLimit,
    resolveEffectiveMaxBytes,
    formatByteSize,
    siteUploadLimitMessage,
};
