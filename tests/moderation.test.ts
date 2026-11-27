/**
 * 审核感知的单元测试。
 *
 * 覆盖写入后的待审检测、免审账号跳过检测、检测失败降级、
 * get-page 的待审版本读取，以及 whoami 的 moderated 报告。
 */

import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Mwn } from 'mwn';
import { describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../src/config/loadConfig.ts';
import { ContentFormat } from '../src/results/contentFormat.ts';
import { ResponseFormatterImpl } from '../src/results/response.ts';
import type { ToolContext } from '../src/runtime/context.ts';
import { ModerationServiceImpl } from '../src/services/moderationService.ts';
import { createPage } from '../src/tools/create-page.ts';
import { getPage } from '../src/tools/get-page.ts';
import { updatePage } from '../src/tools/update-page.ts';
import { whoami } from '../src/tools/whoami.ts';

const SITE_INFO = { server: 'https://wiki.biligame.com', articlepath: '/test' };

const payloadOf = (result: CallToolResult): Record<string, unknown> =>
    result.structuredContent as Record<string, unknown>;

const makeCtx = (mwn: Mwn, enabled = true): ToolContext =>
    ({
        mwn: async () => mwn,
        activeWiki: { get: () => ({ key: 'test' }) },
        siteInfoCache: { get: () => SITE_INFO, isFresh: () => true },
        edit: {
            applyTags: (options: Record<string, unknown>) => ({ ...options }),
            botRight: async () => false,
            submit: async () => ({
                edit: {
                    result: 'Success',
                    pageid: 1,
                    title: 'Page',
                    newrevid: 10,
                    newtimestamp: '2026-01-01T00:00:00Z',
                    contentmodel: 'wikitext',
                },
            }),
        },
        moderation: new ModerationServiceImpl(enabled),
        editSummary: { attribution: false, template: '', noCommentTemplate: '' },
        format: new ResponseFormatterImpl(),
    }) as unknown as ToolContext;

interface ApiStubOptions {
    readonly rights?: string[];
    readonly preload?: unknown;
    readonly preloadError?: Error;
}

/** 记录请求的 mwn 替身，按参数返回 userinfo 或 moderationpreload。 */
const makeMwn = (options: ApiStubOptions = {}) => {
    const requests: Record<string, unknown>[] = [];
    const preload = vi.fn(async () => {
        if (options.preloadError !== undefined) {
            throw options.preloadError;
        }
        return options.preload ?? { query: { moderationpreload: { missing: '' } } };
    });
    const mwn = {
        request: async (params: Record<string, unknown>) => {
            requests.push(params);
            if (params.meta === 'userinfo') {
                return {
                    query: {
                        userinfo: {
                            rights: options.rights ?? ['read', 'edit'],
                        },
                    },
                };
            }
            return preload();
        },
        create: async () => ({ pageid: 0, title: 'New', contentmodel: 'wikitext' }),
    } as unknown as Mwn;
    return { mwn, requests, preload };
};

const pendingPreload = {
    query: {
        moderationpreload: {
            user: 'tester',
            title: 'New',
            pageid: 0,
            wikitext: 'pending text',
            comment: 'please review',
        },
    },
};

describe('create-page 审核检测', () => {
    it('待审时返回 moderated 与重试提示', async () => {
        const { mwn, requests } = makeMwn({ preload: pendingPreload });
        const result = await createPage.handle({ source: 'text', title: 'New' }, makeCtx(mwn));

        expect(result.isError).toBeUndefined();
        const payload = payloadOf(result);
        expect(payload.moderated).toBe(true);
        expect(String(payload.moderationNotice)).toContain('awaiting moderation');
        expect(String(payload.moderationNotice)).toContain('Do not resubmit');
        expect(requests).toContainEqual(
            expect.objectContaining({
                prop: 'moderationpreload',
                mptitle: 'New',
                mpmode: 'wikitext',
            }),
        );
    });

    it('未待审时不增加 moderated 字段', async () => {
        const { mwn } = makeMwn();
        const result = await createPage.handle({ source: 'text', title: 'New' }, makeCtx(mwn));
        expect('moderated' in payloadOf(result)).toBe(false);
    });

    it('检测请求失败时写入结果保持不变', async () => {
        const { mwn } = makeMwn({ preloadError: new Error('boom') });
        const result = await createPage.handle({ source: 'text', title: 'New' }, makeCtx(mwn));
        expect(result.isError).toBeUndefined();
        expect('moderated' in payloadOf(result)).toBe(false);
    });

    it('免审账号不发起预读请求', async () => {
        const { mwn, requests, preload } = makeMwn({
            rights: ['read', 'edit', 'skip-moderation'],
        });
        const result = await createPage.handle({ source: 'text', title: 'New' }, makeCtx(mwn));
        expect('moderated' in payloadOf(result)).toBe(false);
        expect(preload).not.toHaveBeenCalled();
        expect(requests.some(request => request.prop === 'moderationpreload')).toBe(false);
    });

    it('关闭检测后完全不查询审核状态', async () => {
        const { mwn, requests } = makeMwn();
        const result = await createPage.handle(
            { source: 'text', title: 'New' },
            makeCtx(mwn, false),
        );
        expect('moderated' in payloadOf(result)).toBe(false);
        expect(requests).toHaveLength(0);
    });
});

describe('update-page 审核检测', () => {
    it('待审时返回 moderated', async () => {
        const { mwn } = makeMwn({ preload: pendingPreload });
        const result = await updatePage.handle(
            { title: 'Page', operation: 'append', source: '\nnew line' },
            makeCtx(mwn),
        );
        expect(result.isError).toBeUndefined();
        expect(payloadOf(result).moderated).toBe(true);
    });
});

describe('whoami 的 moderated', () => {
    it('缺少 skip-moderation 时为 true，且始终请求 rights', async () => {
        const { mwn, requests } = makeMwn({ rights: ['read', 'edit'] });
        const result = await whoami.handle({ includeRights: false }, makeCtx(mwn));

        expect(requests[0]?.uiprop).toBe('groups|rights');
        expect(payloadOf(result).moderated).toBe(true);
        expect('rights' in payloadOf(result)).toBe(false);
    });

    it('具备 skip-moderation 时为 false', async () => {
        const { mwn } = makeMwn({
            rights: ['read', 'edit', 'skip-moderation'],
        });
        const result = await whoami.handle({ includeRights: true }, makeCtx(mwn));

        expect(payloadOf(result).moderated).toBe(false);
        expect(payloadOf(result).rights).toEqual(['read', 'edit', 'skip-moderation']);
    });
});

describe('get-page 的 includePending', () => {
    it('页面不存在但有待审版本时返回 pending，而不是 not_found', async () => {
        const mwn = {
            read: async () => ({ missing: true, title: 'New' }),
            request: async () => pendingPreload,
        } as unknown as Mwn;
        const result = await getPage.handle(
            {
                title: 'New',
                content: ContentFormat.source,
                metadata: false,
                section: undefined,
                includePending: true,
            },
            makeCtx(mwn),
        );

        expect(result.isError).toBeUndefined();
        expect(payloadOf(result).pending).toMatchObject({
            wikitext: 'pending text',
            comment: 'please review',
        });
        expect(String(payloadOf(result).pendingNotice)).toContain('does not exist yet');
    });

    it('现有页面同时返回实时内容与待审版本', async () => {
        const mwn = {
            read: async () => ({
                pageid: 1,
                title: 'Page',
                revisions: [
                    {
                        revid: 2,
                        timestamp: '2026-01-01T00:00:00Z',
                        contentmodel: 'wikitext',
                        size: 4,
                        content: 'live',
                    },
                ],
            }),
            request: async () => pendingPreload,
        } as unknown as Mwn;
        const result = await getPage.handle(
            {
                title: 'Page',
                content: ContentFormat.source,
                metadata: false,
                section: undefined,
                includePending: true,
            },
            makeCtx(mwn),
        );

        expect(payloadOf(result).source).toBe('live');
        expect(payloadOf(result).pending).toMatchObject({ wikitext: 'pending text' });
    });

    it('未开启 includePending 时不查询待审版本', async () => {
        const requests: Record<string, unknown>[] = [];
        const mwn = {
            request: async (params: Record<string, unknown>) => {
                requests.push(params);
                return {};
            },
            read: async () => ({
                pageid: 1,
                title: 'Page',
                revisions: [
                    {
                        revid: 2,
                        timestamp: '2026-01-01T00:00:00Z',
                        contentmodel: 'wikitext',
                        size: 4,
                        content: 'live',
                    },
                ],
            }),
        } as unknown as Mwn;
        const result = await getPage.handle(
            {
                title: 'Page',
                content: ContentFormat.source,
                metadata: false,
                section: undefined,
                includePending: false,
            },
            makeCtx(mwn),
        );
        expect(payloadOf(result).source).toBe('live');
        expect(requests).toHaveLength(0);
    });

    it('待审查询失败时仍返回实时页面', async () => {
        const mwn = {
            read: async () => ({
                pageid: 1,
                title: 'Page',
                revisions: [
                    {
                        revid: 2,
                        timestamp: '2026-01-01T00:00:00Z',
                        contentmodel: 'wikitext',
                        size: 4,
                        content: 'live',
                    },
                ],
            }),
            request: async () => {
                throw new Error('preload failed');
            },
        } as unknown as Mwn;
        const result = await getPage.handle(
            {
                title: 'Page',
                content: ContentFormat.source,
                metadata: false,
                section: undefined,
                includePending: true,
            },
            makeCtx(mwn),
        );

        expect(result.isError).toBeUndefined();
        expect(payloadOf(result).source).toBe('live');
        expect('pending' in payloadOf(result)).toBe(false);
    });
});

describe('moderationAwareness 配置', () => {
    it('缺省开启', () => {
        expect(resolveConfig({ wikis: ['pod'] }).moderationAwareness).toBe(true);
    });

    it('可以关闭', () => {
        expect(
            resolveConfig({ wikis: ['pod'], moderationAwareness: false }).moderationAwareness,
        ).toBe(false);
    });

    it('非布尔值被拒绝', () => {
        expect(() => resolveConfig({ wikis: ['pod'], moderationAwareness: 'yes' })).toThrow(
            /moderationAwareness/,
        );
    });
});

describe('ModerationServiceImpl', () => {
    it('没有待审版本时返回 undefined', async () => {
        const { mwn } = makeMwn();
        const service = new ModerationServiceImpl(true);
        await expect(service.pending(mwn, 'New')).resolves.toBeUndefined();
    });

    it('免审查询按 Mwn 实例缓存', async () => {
        const { mwn, requests } = makeMwn({
            rights: ['read', 'edit', 'skip-moderation'],
        });
        const service = new ModerationServiceImpl(true);

        await expect(service.exempt(mwn)).resolves.toBe(true);
        await expect(service.exempt(mwn)).resolves.toBe(true);
        expect(requests).toHaveLength(1);
    });

    it('检测关闭时 afterWrite 不发起请求', async () => {
        const { mwn, requests } = makeMwn();
        const service = new ModerationServiceImpl(false);
        await expect(service.afterWrite(mwn, 'New')).resolves.toBeUndefined();
        expect(requests).toHaveLength(0);
    });
});
