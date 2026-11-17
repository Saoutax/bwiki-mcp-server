/**
 * 出站请求头的单元测试。
 *
 * 构建通过、工具调用成功都说明不了实际发出了哪些头——被静默丢弃的 Referer
 * 与正常发送的 Referer 看起来一模一样。所以这里把 Mwn 指向本地监听器，记录
 * 到达的头再断言。
 *
 * 只有请求头的组装逻辑在被测：请求不出本机，也不碰 BWiki。
 */

import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import { Mwn } from 'mwn';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { refererFor, USER_AGENT } from '../src/runtime/constants.ts';

// 监听器收到的每个请求的头。
const seen: IncomingHttpHeaders[] = [];

let server: Server;
let apiUrl = '';

beforeAll(async () => {
    server = createServer((req, res) => {
        seen.push(req.headers);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ batchcomplete: true, query: {} }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

    const address = server.address();
    if (address === null || typeof address === 'string') {
        throw new Error('本地监听器没有拿到端口');
    }
    apiUrl = `http://127.0.0.1:${address.port}/example/api.php`;

    const bot = new Mwn({ apiUrl, userAgent: USER_AGENT });
    // 与 mwnProvider 的 applyReferer 同一接线：就地写 defaults.headers.common。
    const referer = refererFor(apiUrl);
    if (referer === undefined) {
        throw new Error('refererFor 未能从本地 API 地址推导出 Referer');
    }
    bot.axiosInstance.defaults.headers.common.Referer = referer;

    await bot.rawRequest({
        url: apiUrl,
        method: 'GET',
        params: { action: 'query', meta: 'siteinfo', format: 'json' },
    });
});

afterAll(async () => {
    await new Promise<void>(resolve => {
        server.close(() => resolve());
    });
});

/** 最近一个请求的头，供各断言共用。 */
const headersOfLastRequest = (): IncomingHttpHeaders => seen.at(-1) ?? {};

describe('出站请求头', () => {
    it('请求确实到达', () => {
        expect(seen.length).toBeGreaterThan(0);
    });

    it('User-Agent 是 Chrome 桌面版', () => {
        expect(String(headersOfLastRequest()['user-agent'])).toMatch(
            /^Mozilla\/5\.0 .*Chrome\/\d+/,
        );
    });

    it('Referer 指向同一 wiki', () => {
        const { port } = new URL(apiUrl);
        expect(String(headersOfLastRequest().referer ?? '')).toBe(
            `http://127.0.0.1:${port}/example/`,
        );
    });

    it('refererFor 对 BWiki 地址推导正确', () => {
        expect(refererFor('https://example.org/example/api.php')).toBe(
            'https://example.org/example/',
        );
    });

    it('refererFor 对非法地址返回 undefined', () => {
        expect(refererFor('not-a-url')).toBeUndefined();
    });
});
