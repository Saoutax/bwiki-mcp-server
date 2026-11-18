/**
 * 工具可见性重算的单元测试。
 *
 * 扩展与 wikiGate 规则必须 fail-open：站点不可达时无法判断能力，若据此禁用
 * 工具，一次网络抖动就会让客户端看到工具消失。只有「可达且确实缺失」才
 * 关掉它们，真正的按调用校验仍会拒绝不满足的站点。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WikiConfig } from '../src/config/loadConfig.ts';
import {
    buildExtensionRules,
    computeDesiredEnabledState,
    type ReconcileContext,
} from '../src/runtime/reconcile.ts';
import type { ExtensionPack } from '../src/tools/extensions/types.ts';
import type { WikiProbe } from '../src/wikis/wikiProbe.ts';

const SMW_TOOLS = ['smw-query', 'smw-list-properties'] as const;

/** probe.inspect() 的返回值（含 reachable 与扩展集合）。 */
type ProbeIdentity = Awaited<ReturnType<WikiProbe['inspect']>>;

const reachable = (extensions: readonly string[] = []): ProbeIdentity => ({
    reachable: true,
    extensions: new Set(extensions),
});

const unreachable = (): ProbeIdentity => ({ reachable: false, extensions: new Set() });

const makeContext = (identities: Record<string, ProbeIdentity>): ReconcileContext => {
    const allWikis = Object.fromEntries(
        Object.keys(identities).map(key => [key, {} as WikiConfig]),
    );
    const wikiProbe = {
        inspect: async (key: string): Promise<ProbeIdentity> => identities[key] ?? unreachable(),
        hasExtension: async (key: string, name: string): Promise<boolean> =>
            identities[key]?.extensions.has(name) ?? false,
        hasAnyExtension: async (key: string, names: readonly string[]): Promise<boolean> =>
            names.some(name => identities[key]?.extensions.has(name) === true),
        invalidate: (): void => {},
    };
    return {
        allWikis,
        wikiCount: Object.keys(allWikis).length,
        allowManagement: false,
        transport: 'stdio',
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- 测试替身，只实现规则用到的成员
        wikiProbe: wikiProbe as unknown as WikiProbe,
    };
};

const makePack = (gateSatisfied: boolean): ExtensionPack =>
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- 测试替身，工具只需要 name
    ({
        id: 'smw',
        extensionNames: ['SemanticMediaWiki'],
        tools: SMW_TOOLS.map(name => ({ name })),
        wikiGate: {
            tools: ['smw-query'],
            isSatisfied: (): boolean => gateSatisfied,
            refusal: (wikiKey: string): string => `gate refused on ${wikiKey}`,
        },
    }) as unknown as ExtensionPack;

const desiredOf = async (
    identities: Record<string, ProbeIdentity>,
    pack: ExtensionPack,
): Promise<Map<string, boolean>> =>
    computeDesiredEnabledState(SMW_TOOLS, makeContext(identities), buildExtensionRules([pack]));

afterEach(() => {
    vi.useRealTimers();
});

describe('扩展规则', () => {
    it('任一可达站点具备扩展即保留工具', async () => {
        const desired = await desiredOf(
            { a: reachable(), b: reachable(['SemanticMediaWiki']) },
            makePack(true),
        );
        expect(desired.get('smw-query')).toBe(true);
        expect(desired.get('smw-list-properties')).toBe(true);
    });

    it('全部可达且都没有扩展时禁用工具（fail-closed 的正确情形）', async () => {
        const desired = await desiredOf(
            { a: reachable(['VisualEditor']), b: reachable() },
            makePack(true),
        );
        expect(desired.get('smw-query')).toBe(false);
        expect(desired.get('smw-list-properties')).toBe(false);
    });

    it('有站点不可达时 fail-open，不因探测失败禁用工具', async () => {
        const desired = await desiredOf({ a: reachable(), b: unreachable() }, makePack(false));
        expect(desired.get('smw-list-properties')).toBe(true);
    });

    it('无站点可判断（全不可达）时也不禁用', async () => {
        const desired = await desiredOf({ a: unreachable(), b: unreachable() }, makePack(false));
        expect(desired.get('smw-query')).toBe(true);
        expect(desired.get('smw-list-properties')).toBe(true);
    });
});

describe('wikiGate 规则', () => {
    it('扩展在但门槛不满足时只禁用门槛覆盖的工具', async () => {
        const desired = await desiredOf({ a: reachable(['SemanticMediaWiki']) }, makePack(false));
        expect(desired.get('smw-query')).toBe(false);
        expect(desired.get('smw-list-properties')).toBe(true);
    });

    it('站点不可达时门槛规则 fail-open', async () => {
        const desired = await desiredOf(
            { a: reachable(['SemanticMediaWiki']), b: unreachable() },
            makePack(false),
        );
        expect(desired.get('smw-query')).toBe(true);
    });
});

describe('无定时器', () => {
    it('重算不依赖计时器，可在冻结时钟下完成', async () => {
        vi.useFakeTimers();
        // inspect 是立即 resolve 的异步函数；若实现里引入 setTimeout，
        // 这个 await 会一直挂到测试超时。
        const desired = await desiredOf(
            { a: reachable(['SemanticMediaWiki']), b: unreachable() },
            makePack(true),
        );
        expect(desired.get('smw-query')).toBe(true);
    });
});
