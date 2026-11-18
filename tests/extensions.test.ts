/**
 * 扩展包词汇与门槛声明的启动期校验。
 *
 * 覆盖点：重复错误码的报错点名真正的包（而不是把码名当包名）、
 * 与 MediaWiki 核心错误码冲突时报错、合并结果与门槛校验。
 */

import { describe, expect, it } from 'vitest';
import {
    assertWikiGatesNameOwnTools,
    extensionErrorVocabulary,
    extensionPacks,
} from '../src/tools/extensions/index.ts';
import type { ExtensionPack } from '../src/tools/extensions/types.ts';

const fakeTool = (name: string): ExtensionPack['tools'][number] =>
    ({ name }) as unknown as ExtensionPack['tools'][number];

const pack = (overrides: Partial<ExtensionPack> & { id: string }): ExtensionPack => ({
    extensionNames: [],
    tools: [],
    ...overrides,
});

describe('extensionErrorVocabulary', () => {
    it('包间重复声明时点名两个真实的包', () => {
        const first = pack({ id: 'pack-a', errorCodes: { 'smw-dupe': 'upstream_failure' } });
        const second = pack({ id: 'pack-b', errorCodes: { 'smw-dupe': 'invalid_input' } });

        expect(() => extensionErrorVocabulary([first, second])).toThrow(
            'Extension packs "pack-a" and "pack-b" both declare error code "smw-dupe".',
        );
    });

    it('与核心错误码冲突时拒绝', () => {
        const claiming = pack({ id: 'pack-c', errorCodes: { missingtitle: 'not_found' } });

        expect(() => extensionErrorVocabulary([claiming])).toThrow(
            'Extension pack "pack-c" declares error code "missingtitle", which MediaWiki itself defines.',
        );
    });

    it('合并各包的错误码与码族前缀', () => {
        const prefix: readonly [RegExp, 'upstream_failure'] = [/^smw-/, 'upstream_failure'];
        const first = pack({
            id: 'pack-a',
            errorCodes: { 'smw-a': 'upstream_failure' },
            errorCodePrefixes: [prefix],
        });
        const second = pack({ id: 'pack-b', errorCodes: { 'smw-b': 'invalid_input' } });

        expect(extensionErrorVocabulary([first, second])).toEqual({
            codes: { 'smw-a': 'upstream_failure', 'smw-b': 'invalid_input' },
            prefixes: [prefix],
        });
    });

    it('随附的扩展包词汇可构建通过', () => {
        expect(extensionPacks.map(p => p.id)).toContain('smw');
        expect(() => extensionErrorVocabulary(extensionPacks)).not.toThrow();
    });
});

describe('assertWikiGatesNameOwnTools', () => {
    const gate = (tools: string[]): NonNullable<ExtensionPack['wikiGate']> => ({
        tools,
        isSatisfied: () => true,
        refusal: (wikiKey: string) => `${wikiKey} lacks the extension`,
    });

    it('门槛声明的工具属于该包时通过', () => {
        const owner = pack({
            id: 'pack-a',
            tools: [fakeTool('smw-query')],
            wikiGate: gate(['smw-query']),
        });

        expect(() => assertWikiGatesNameOwnTools([owner])).not.toThrow();
    });

    it('门槛声明本包未提供的工具时在启动期失败', () => {
        const owner = pack({
            id: 'pack-a',
            tools: [fakeTool('smw-query')],
            wikiGate: gate(['smw-other']),
        });

        expect(() => assertWikiGatesNameOwnTools([owner])).toThrow(
            'Extension pack "pack-a" declares a wikiGate for "smw-other", which it does not provide.',
        );
    });
});
