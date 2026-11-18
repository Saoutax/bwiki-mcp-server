/**
 * list-wikis 的载荷测试。
 *
 * 覆盖点：分页截断附标准 truncation 标记、仅配置站点的 sitename 回退
 * （siteinfo 缓存 → 配置 → 代号）。
 */

import { describe, expect, it, vi } from 'vitest';
import type { FarmWiki } from '../src/bwiki/farm.ts';
import type { WikiConfig } from '../src/config/loadConfig.ts';
import { ResponseFormatterImpl } from '../src/results/response.ts';
import type { ToolContext } from '../src/runtime/context.ts';

const { discoverFarmWikis } = vi.hoisted(() => ({ discoverFarmWikis: vi.fn() }));

vi.mock('../src/bwiki/farm.ts', () => ({ discoverFarmWikis }));
vi.mock('../src/bwiki/cookie.ts', () => ({
    readSessionFile: async () => null,
    wikiCookiePartsFor: () => [],
}));
vi.mock('../src/config/loadConfig.ts', () => ({
    DEFAULT_SESSION_FILE: '/nonexistent/session.json',
    loadConfigFromFile: () => ({ wikis: {} }),
}));

const { listWikis } = await import('../src/tools/list-wikis.ts');

interface WikiRow {
    key: string;
    sitename: string;
    configured: boolean;
}

interface ListPayload {
    wikis: WikiRow[];
    total: number;
    returned: number;
    truncated: boolean;
    truncation?: {
        reason: string;
        returnedCount: number;
        limit: number;
        itemNoun: string;
        narrowHint: string;
    };
}

const configOf = (sitename: string): WikiConfig => ({
    sitename,
    server: 'https://wiki.biligame.com/demo',
    articlepath: '/demo/$1',
    scriptpath: '/w',
});

const rosterRow = (key: string): FarmWiki => ({
    key,
    sitename: key.toUpperCase(),
    server: `https://wiki.biligame.com/${key}`,
    configured: false,
});

const makeCtx = (
    configs: Record<string, WikiConfig>,
    cachedNames: Record<string, { sitename?: string; server: string; articlepath: string }>,
): ToolContext =>
    ({
        wikis: {
            get: (key: string) => configs[key],
            getAll: () => configs,
            add: () => undefined,
            remove: () => undefined,
            isManagementAllowed: () => false,
        },
        activeWiki: {
            get: () => ({ key: 'src', config: configOf('Source') }),
            getDefaultKey: () => 'src',
        },
        siteInfoCache: {
            get: (key: string) => cachedNames[key],
            isFresh: () => true,
            set: () => undefined,
            deferRefetch: () => undefined,
            delete: () => undefined,
        },
        format: new ResponseFormatterImpl(),
    }) as unknown as ToolContext;

const payloadOf = (result: { structuredContent?: unknown }): ListPayload =>
    result.structuredContent as ListPayload;

describe('分页截断', () => {
    it('超出 limit 时附 capped-no-continuation 标记', async () => {
        discoverFarmWikis.mockResolvedValue([rosterRow('a'), rosterRow('b'), rosterRow('c')]);
        const ctx = makeCtx({}, {});

        const result = await listWikis.handle(
            { limit: 2, query: undefined, configuredOnly: undefined },
            ctx,
        );

        const payload = payloadOf(result);
        expect(payload.total).toBe(3);
        expect(payload.returned).toBe(2);
        expect(payload.truncated).toBe(true);
        expect(payload.truncation).toEqual({
            reason: 'capped-no-continuation',
            returnedCount: 2,
            limit: 2,
            itemNoun: 'wikis',
            narrowHint: expect.any(String),
        });
    });

    it('未超出 limit 时不附 truncation', async () => {
        discoverFarmWikis.mockResolvedValue([rosterRow('a')]);
        const ctx = makeCtx({}, {});

        const result = await listWikis.handle(
            { limit: 50, query: undefined, configuredOnly: undefined },
            ctx,
        );

        const payload = payloadOf(result);
        expect(payload.truncated).toBe(false);
        expect(payload.truncation).toBeUndefined();
    });
});

describe('仅配置站点的 sitename 回退', () => {
    it('优先用 siteinfo 缓存，其次配置，最后代号', async () => {
        discoverFarmWikis.mockResolvedValue([]);
        const configs: Record<string, WikiConfig> = {
            'cfg-cached': configOf(''),
            'cfg-configured': configOf('Configured Name'),
            'cfg-fallback': configOf(''),
        };
        const cachedNames = {
            'cfg-cached': {
                sitename: 'Site Info Name',
                server: 'https://wiki.biligame.com/cfg-cached',
                articlepath: '/cfg-cached/$1',
            },
            // 缓存里是空串时同样应退到配置值。
            'cfg-configured': {
                sitename: '',
                server: 'https://wiki.biligame.com/cfg-configured',
                articlepath: '/cfg-configured/$1',
            },
        };
        const ctx = makeCtx(configs, cachedNames);

        const result = await listWikis.handle(
            { limit: 50, query: undefined, configuredOnly: true },
            ctx,
        );

        const payload = payloadOf(result);
        const byKey = new Map(payload.wikis.map(w => [w.key, w.sitename]));
        expect(byKey.get('cfg-cached')).toBe('Site Info Name');
        expect(byKey.get('cfg-configured')).toBe('Configured Name');
        // 缓存与配置都为空时用代号，而不是空串。
        expect(byKey.get('cfg-fallback')).toBe('cfg-fallback');
    });
});
