// siteinfo.general.server 可能是协议相对 URL（"//host"），统一补为 https。
//
// 供认证态 siteInfo 与匿名 wikiProbe 共用。
const normalizeServer = (server: string): string =>
    server.startsWith('//') ? 'https:' + server : server;

export { normalizeServer };
