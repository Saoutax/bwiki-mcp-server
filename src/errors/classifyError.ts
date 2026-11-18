import {
    RedirectDropsBodyError,
    InsecureRedirectError,
    TooManyRedirectsError,
    UnusableLocationError,
} from '../requestChain.ts';
import { SsrfValidationError } from '../ssrfGuard.ts';
import { CredentialResolutionError } from './credentialResolutionError.ts';
import { WikiTimeoutError } from './wikiTimeoutError.ts';

type ErrorCategory =
    | 'not_found'
    | 'permission_denied'
    | 'invalid_input'
    | 'conflict'
    | 'upstream_failure'
    | 'rate_limited'
    | 'authentication';

interface ErrorClassifier {
    classify(err: unknown): { category: ErrorCategory; code?: string };
}

const MW_CODE_TO_CATEGORY: Record<string, ErrorCategory> = {
    // not_found
    missingtitle: 'not_found',
    nosuchrevid: 'not_found',
    nosuchsection: 'not_found',
    nofile: 'not_found',
    // 标题不存在时的非 create 保护。
    'missingtitle-createonly': 'not_found',
    // permission_denied
    permissiondenied: 'permission_denied',
    protectedpage: 'permission_denied',
    protectedtitle: 'permission_denied',
    cascadeprotected: 'permission_denied',
    cantcreate: 'permission_denied',
    cantmove: 'permission_denied',
    'cantmove-anon': 'permission_denied',
    readapidenied: 'permission_denied',
    writeapidenied: 'permission_denied',
    blocked: 'permission_denied',
    'abusefilter-disallowed': 'permission_denied',
    'abusefilter-warning': 'permission_denied',
    // 缺少 $wgNamespaceProtection 所需权限。需匹配四种拼写。
    protectednamespace: 'permission_denied',
    'protectednamespace-interface': 'permission_denied',
    namespaceprotected: 'permission_denied',
    protectedinterface: 'permission_denied',
    // invalid_input
    invalidtitle: 'invalid_input',
    invalidparammix: 'invalid_input',
    badvalue: 'invalid_input',
    baddatatype: 'invalid_input',
    paramempty: 'invalid_input',
    badtags: 'invalid_input',
    selfmove: 'invalid_input',
    immobilenamespace: 'invalid_input',
    nonfilenamespace: 'invalid_input',
    filetypemismatch: 'invalid_input',
    toomanyvalues: 'invalid_input',
    'protect-invalidaction': 'invalid_input',
    'protect-invalidlevel': 'invalid_input',
    invalidexpiry: 'invalid_input',
    pastexpiry: 'invalid_input',
    'create-titleexists': 'invalid_input',
    // conflict
    editconflict: 'conflict',
    articleexists: 'conflict',
    fileexists: 'conflict',
    'fileexists-no-change': 'conflict',
    // authentication
    notloggedin: 'authentication',
    badtoken: 'authentication',
    mustbeloggedin: 'authentication',
    assertuserfailed: 'authentication',
    assertbotfailed: 'authentication',
    // OAuth token 失效，归类为 authentication 以便调用方区分于上游故障。
    'mwoauth-invalid-authorization': 'authentication',
    // rate_limited
    ratelimited: 'rate_limited',
    // 上传：文件名被服务端改写属于调用方输入问题；
    // upload-warning 是 action=upload 的通用警告，既非成功也不是已知的文件冲突。
    badfilename: 'invalid_input',
    'upload-warning': 'upstream_failure',
    // 未识别的错误码也归入此类
    readonly: 'upstream_failure',
    // 本服务自身产生的码，列出以便扩展包冲突检查覆盖。
    'request-timeout': 'upstream_failure',
};

// 按前缀匹配的编号错误码族。
const CODE_PREFIX_PATTERNS: readonly (readonly [RegExp, ErrorCategory])[] = [
    [/^internal_api_error_/, 'upstream_failure'],
];

/**
 * 上游以 HTTP 状态码表达限流的取值。
 *
 * 429 是标准限流，567/514 是 EdgeOne 的拦截。三者都应让调用方退避后重试，
 * 而不是报成上游故障。
 */
const RATE_LIMIT_STATUSES = new Set([429, 567, 514]);

const responseStatusOf = (err: object): number | undefined => {
    const response = (err as { response?: { status?: unknown } }).response;
    return typeof response?.status === 'number' ? response.status : undefined;
};

// 部分错误码只出现在消息里，用以下模式推断后再查表。
const MESSAGE_FALLBACK_PATTERNS: readonly (readonly [RegExp, string])[] = [
    [/\bmissingtitle\b/i, 'missingtitle'],
    [/\bnosuchrevid\b/i, 'nosuchrevid'],
    [/\bnosuchsection\b/i, 'nosuchsection'],
    [/\beditconflict\b/i, 'editconflict'],
    [/\bratelimited\b/i, 'ratelimited'],
];

/** 这些异常由本地安全策略产生，属于调用方输入问题而非上游故障。 */
const isInputValidationError = (err: unknown): boolean =>
    err instanceof SsrfValidationError ||
    err instanceof InsecureRedirectError ||
    err instanceof RedirectDropsBodyError ||
    err instanceof TooManyRedirectsError ||
    err instanceof UnusableLocationError;

/**
 * 扩展包提供的错误码。
 */
interface ExtensionErrorVocabulary {
    codes: Readonly<Record<string, ErrorCategory>>;
    prefixes: readonly (readonly [RegExp, ErrorCategory])[];
}

const NO_EXTENSION_CODES: ExtensionErrorVocabulary = { codes: {}, prefixes: [] };

const classifyError = (
    err: unknown,
    extensions: ExtensionErrorVocabulary = NO_EXTENSION_CODES,
): { category: ErrorCategory; code?: string } => {
    if (err instanceof CredentialResolutionError) {
        return { category: 'authentication' };
    }
    // 自身无 code，否则会被报成裸 upstream_failure。
    if (err instanceof WikiTimeoutError) {
        return { category: 'upstream_failure', code: 'request-timeout' };
    }
    // 本地安全策略的拒绝：问题在目标 URL，归为调用方输入错误。
    if (isInputValidationError(err)) {
        return { category: 'invalid_input' };
    }
    if (err !== null && typeof err === 'object') {
        // 状态码优先于错误码：限流由传输层表达，码表里未必有对应项。
        const status = responseStatusOf(err);
        if (status !== undefined && RATE_LIMIT_STATUSES.has(status)) {
            return { category: 'rate_limited' };
        }

        const code = (err as { code?: unknown }).code;
        if (typeof code === 'string') {
            // 先查核心定义；重叠在注册时已拒绝。
            const mapped = MW_CODE_TO_CATEGORY[code] ?? extensions.codes[code];
            if (mapped) {
                return { category: mapped, code };
            }
            for (const [pattern, category] of [...CODE_PREFIX_PATTERNS, ...extensions.prefixes]) {
                if (pattern.test(code)) {
                    return { category, code };
                }
            }
        }

        // 码表与前缀都没命中时再看消息：有些 MediaWiki 错误只把码写进文案，
        // 即使 err.code 是个无关的字符串也应尝试推断。
        const message = (err as { message?: unknown }).message;
        if (typeof message === 'string') {
            for (const [pattern, inferredCode] of MESSAGE_FALLBACK_PATTERNS) {
                if (pattern.test(message)) {
                    return {
                        category: MW_CODE_TO_CATEGORY[inferredCode],
                        code: inferredCode,
                    };
                }
            }
        }
    }
    return { category: 'upstream_failure' };
};

class ErrorClassifierImpl implements ErrorClassifier {
    public constructor(
        private readonly extensions: ExtensionErrorVocabulary = NO_EXTENSION_CODES,
    ) {}

    public classify(err: unknown): { category: ErrorCategory; code?: string } {
        return classifyError(err, this.extensions);
    }
}

/** The core vocabulary, for the registration check that keeps packs out of it. */
const coreErrorCodes = (): Readonly<Record<string, ErrorCategory>> => MW_CODE_TO_CATEGORY;

export { ErrorClassifierImpl, classifyError, coreErrorCodes };
export type { ErrorCategory, ErrorClassifier, ExtensionErrorVocabulary };
