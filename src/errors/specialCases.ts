import type { ErrorCategory } from './classifyError.ts';
import { errorMessage } from './isErrnoException.ts';

interface SpecialCaseResult {
    category: ErrorCategory;
    code: string;
    message: string;
}

type Override = (
    err: unknown,
    context: { toolName: string; defaultMessage: string },
) => SpecialCaseResult | null;

const pickFromMessage = (msg: string, pattern: RegExp): string | undefined =>
    msg.match(pattern)?.[1];

// 只有这些工具使用定制错误文案，其余工具沿用
// dispatcher 的 "Failed to <verb>: <raw>" 统一格式。
const TAILORED_TOOLS: Record<string, ReadonlySet<string>> = {
    missingtitle: new Set(['compare-pages']),
    nosuchrevid: new Set(['compare-pages']),
    nosuchsection: new Set(['update-page']),
};

const appliesTo = (code: string, toolName: string): boolean =>
    TAILORED_TOOLS[code]?.has(toolName) ?? false;

const overrides: Record<string, Override> = {
    nosuchsection: (err, { toolName }) => {
        if (!appliesTo('nosuchsection', toolName)) {
            return null;
        }
        const msg = errorMessage(err, '');
        const sectionMatch = pickFromMessage(msg, /section[^\d]*(\d+)/i);
        const label = sectionMatch ?? 'unknown';
        return {
            category: 'not_found',
            code: 'nosuchsection',
            message: `Section ${label} does not exist`,
        };
    },
    nosuchrevid: (err, { toolName }) => {
        if (!appliesTo('nosuchrevid', toolName)) {
            return null;
        }
        const msg = errorMessage(err, '');
        const idMatch = pickFromMessage(msg, /\b(\d+)\b/);
        return {
            category: 'not_found',
            code: 'nosuchrevid',
            message: idMatch !== undefined ? `Revision ${idMatch} not found` : 'Revision not found',
        };
    },
    missingtitle: (err, { toolName }) => {
        if (!appliesTo('missingtitle', toolName)) {
            return null;
        }
        const msg = errorMessage(err, '');
        const titleMatch = pickFromMessage(msg, /["'`]([^"'`]+)["'`]/);
        return {
            category: 'not_found',
            code: 'missingtitle',
            message: titleMatch !== undefined ? `Page "${titleMatch}" not found` : 'Page not found',
        };
    },
};

const applySpecialCase = (
    toolName: string,
    classified: { category: ErrorCategory; code?: string },
    err: unknown,
): { category: ErrorCategory; code: string | undefined; message: string } => {
    const defaultMessage = errorMessage(err);
    if (classified.code && overrides[classified.code]) {
        const result = overrides[classified.code](err, { toolName, defaultMessage });
        if (result) {
            return result;
        }
    }
    return { category: classified.category, code: classified.code, message: defaultMessage };
};

export { applySpecialCase };
export type { SpecialCaseResult };
