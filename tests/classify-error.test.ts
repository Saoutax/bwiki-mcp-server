/**
 * 错误分类的单元测试。
 *
 * 覆盖三类容易漏判的输入：
 *  - HTTP 429/567/514 表达的是限流，不是上游故障；
 *  - 本地 SSRF/重定向拒绝属于调用方输入问题；
 *  - 即使 err.code 是无关键的字符串，消息里的 MediaWiki 错误码仍应被识别。
 */

import { describe, expect, it } from 'vitest';
import { classifyError } from '../src/errors/classifyError.ts';
import { CredentialResolutionError } from '../src/errors/credentialResolutionError.ts';
import { WikiTimeoutError } from '../src/errors/wikiTimeoutError.ts';
import {
    InsecureRedirectError,
    RedirectDropsBodyError,
    TooManyRedirectsError,
    UnusableLocationError,
} from '../src/requestChain.ts';
import { SsrfValidationError } from '../src/ssrfGuard.ts';

const withResponseStatus = (status: number, extra: Record<string, unknown> = {}): unknown => ({
    message: `Request failed with status code ${status}`,
    code: 'ERR_BAD_RESPONSE',
    response: { status },
    ...extra,
});

describe('HTTP 状态码分类', () => {
    it('429 归为 rate_limited', () => {
        expect(classifyError(withResponseStatus(429)).category).toBe('rate_limited');
    });

    it('EdgeOne 的 567/514 归为 rate_limited', () => {
        expect(classifyError(withResponseStatus(567)).category).toBe('rate_limited');
        expect(classifyError(withResponseStatus(514)).category).toBe('rate_limited');
    });

    it('其他状态码不误判为限流', () => {
        expect(classifyError(withResponseStatus(500)).category).toBe('upstream_failure');
    });

    it('状态码优先于无关的错误码', () => {
        expect(
            classifyError({
                code: 'something-unknown',
                response: { status: 429 },
            }).category,
        ).toBe('rate_limited');
    });
});

describe('本地安全策略的拒绝', () => {
    it('SsrfValidationError 归为 invalid_input', () => {
        expect(classifyError(new SsrfValidationError('blocked')).category).toBe('invalid_input');
    });

    it('重定向拒绝族归为 invalid_input', () => {
        const refusals = [
            new InsecureRedirectError(302, 'http://example.org/'),
            new RedirectDropsBodyError(302, 'https://example.org/'),
            new TooManyRedirectsError('https://example.org/'),
            new UnusableLocationError(302),
        ];
        for (const err of refusals) {
            expect(classifyError(err).category).toBe('invalid_input');
        }
    });
});

describe('错误码表', () => {
    it('已知 MediaWiki 错误码按表分类', () => {
        expect(classifyError({ code: 'missingtitle', message: 'x' }).category).toBe('not_found');
        expect(classifyError({ code: 'permissiondenied', message: 'x' }).category).toBe(
            'permission_denied',
        );
        expect(classifyError({ code: 'editconflict', message: 'x' }).category).toBe('conflict');
    });

    it('上传相关的码：badfilename 是输入问题，upload-warning 是上游警告', () => {
        expect(classifyError({ code: 'badfilename', message: 'x' }).category).toBe('invalid_input');
        expect(classifyError({ code: 'upload-warning', message: 'x' }).category).toBe(
            'upstream_failure',
        );
        expect(classifyError({ code: 'fileexists', message: 'x' }).category).toBe('conflict');
    });

    it('前缀错误码按前缀分类', () => {
        expect(
            classifyError({ code: 'internal_api_error_DBQueryError', message: '' }).category,
        ).toBe('upstream_failure');
    });

    it('扩展包词汇参与分类', () => {
        const extensions = {
            codes: { 'smw-badquery': 'invalid_input' as const },
            prefixes: [[/^smw-/, 'invalid_input' as const]] as const,
        };
        expect(classifyError({ code: 'smw-badquery' }, extensions).category).toBe('invalid_input');
        expect(classifyError({ code: 'smw-other' }, extensions).category).toBe('invalid_input');
    });

    it('固定异常优先于码表', () => {
        expect(classifyError(new CredentialResolutionError('x')).category).toBe('authentication');
        expect(classifyError(new WikiTimeoutError(150_000, 'calling'))).toEqual({
            category: 'upstream_failure',
            code: 'request-timeout',
        });
    });
});

describe('消息回退', () => {
    it('无 code 时从消息推断', () => {
        expect(classifyError({ message: 'Error: missingtitle' })).toEqual({
            category: 'not_found',
            code: 'missingtitle',
        });
    });

    it('code 为无关键字符串时仍从消息推断', () => {
        expect(
            classifyError({ code: 'ERR_BAD_REQUEST', message: 'Cannot find missingtitle page' }),
        ).toEqual({ category: 'not_found', code: 'missingtitle' });
        expect(
            classifyError({ code: 'ERR_BAD_REQUEST', message: 'The editconflict was detected' })
                .category,
        ).toBe('conflict');
    });

    it('码表命中时不使用消息回退', () => {
        // 码表优先：permissiondenied 的消息里即便提到 missingtitle 也按码表分类。
        expect(
            classifyError({ code: 'permissiondenied', message: 'missingtitle mentioned' }).category,
        ).toBe('permission_denied');
    });

    it('无法判定时归为 upstream_failure', () => {
        expect(classifyError(new Error('boom')).category).toBe('upstream_failure');
        expect(classifyError(null).category).toBe('upstream_failure');
        expect(classifyError('string error').category).toBe('upstream_failure');
    });
});
