/**
 * dispatcher 的单元测试。
 *
 * 覆盖 dispatcher 作为「唯一的调用出口」必须保证的三件事：
 *  - 一次调用只有一份总预算，pre-flight 的 ctx.mwn() 与工具本体共用；
 *  - 早退路径（未知站点 / 能力拒绝 / 登录门）也要留下 tool_call 遥测；
 *  - 在途计数成对增减，遥测抛错不影响调用结果。
 */

import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Mwn } from 'mwn';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ZodRawShape } from 'zod';
import { sessionLiveness } from '../src/bwiki/liveness.ts';
import { DEFAULT_EDIT_SUMMARY } from '../src/config/editSummary.ts';
import { ErrorClassifierImpl } from '../src/errors/classifyError.ts';
import { ResponseFormatterImpl } from '../src/results/response.ts';
import type { CallDeadline } from '../src/runtime/callDeadline.ts';
import { WIKI_CALL_TIMEOUT_MS } from '../src/runtime/callDeadline.ts';
import type { ToolContext } from '../src/runtime/context.ts';
import { dispatch } from '../src/runtime/dispatcher.ts';
import { count } from '../src/runtime/inFlight.ts';
import { logger } from '../src/runtime/logger.ts';
import { getRequestDeadline } from '../src/runtime/requestContext.ts';
import type { Tool } from '../src/runtime/tool.ts';

const DEFAULT_KEY = 'default-wiki';
const OTHER_KEY = 'other-wiki';

const WIKI_CONFIG = {
    sitename: '',
    server: 'https://example.org/default',
    articlepath: '/default',
    scriptpath: '',
};

const originalLogLevel = process.env.MCP_LOG_LEVEL;
let stderrChunks: string[] = [];

const fakeBot = (): Mwn =>
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- 测试替身，只实现 userinfo
    ({ userinfo: async () => ({ name: '100000000' }) }) as unknown as Mwn;

interface CtxOptions {
    login?: { ready: boolean; message: string };
    wikis?: Record<string, unknown>;
    hasExtension?: boolean;
    reachable?: boolean;
    mwn?: (wikiKey?: string) => Promise<Mwn>;
}

const makeCtx = (options: CtxOptions = {}): ToolContext => {
    const wikis = options.wikis ?? { [DEFAULT_KEY]: WIKI_CONFIG };
    const ctx = {
        mwn: options.mwn ?? (async () => fakeBot()),
        wikis: {
            getAll: (): Record<string, unknown> => wikis,
            get: (key: string): unknown => (Object.hasOwn(wikis, key) ? wikis[key] : undefined),
        },
        activeWiki: {
            get: () => ({ key: DEFAULT_KEY, config: WIKI_CONFIG }),
            getDefaultKey: () => DEFAULT_KEY,
        },
        wikiProbe: {
            hasExtension: async (): Promise<boolean> => options.hasExtension ?? false,
            hasAnyExtension: async (): Promise<boolean> => options.hasExtension ?? false,
            inspect: async (): Promise<{ reachable: boolean; extensions: Set<string> }> => ({
                reachable: options.reachable ?? true,
                extensions: new Set<string>(),
            }),
            invalidate: (): void => {},
        },
        loginGate: {
            ensureLoggedIn: (): { ready: boolean; message: string } =>
                options.login ?? { ready: true, message: '' },
            restartLogin: (): { ready: boolean; message: string } => ({
                ready: false,
                message: 'login restarted',
            }),
            isLoggedIn: (): boolean => true,
            markLoggedIn: (): void => {},
            forget: async (): Promise<void> => undefined,
        },
        format: new ResponseFormatterImpl(),
        errors: new ErrorClassifierImpl(),
        logger,
        transport: 'stdio',
        editSummary: DEFAULT_EDIT_SUMMARY,
    };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- 测试替身，只实现 dispatcher 读取的成员
    return ctx as unknown as ToolContext;
};

type Handler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<CallToolResult>;

const makeTool = (name: string, handle: Handler): Tool<ZodRawShape, ToolContext> =>
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- 测试替身；dispatcher 只读取描述符字段
    ({
        name,
        description: '',
        inputSchema: {},
        annotations: { readOnlyHint: true },
        handle,
    }) as unknown as Tool<ZodRawShape, ToolContext>;

const call = async (
    tool: Tool<ZodRawShape, ToolContext>,
    ctx: ToolContext,
    args: Record<string, unknown>,
): Promise<CallToolResult> => dispatch(tool, ctx)(args as never);

const contentText = (result: CallToolResult): string => {
    const first = result.content[0];
    return first !== undefined && 'text' in first ? first.text : '';
};

const envelopeOf = (result: CallToolResult): Record<string, unknown> =>
    JSON.parse(contentText(result)) as Record<string, unknown>;

const toolCallEvents = (): Array<Record<string, unknown>> =>
    stderrChunks
        .join('')
        .split('\n')
        .filter(line => line.trim() !== '')
        .map(line => JSON.parse(line) as Record<string, unknown>)
        .filter(entry => entry.event === 'tool_call');

const resetEvents = (): void => {
    stderrChunks = [];
};

beforeEach(() => {
    process.env.MCP_LOG_LEVEL = 'debug';
    sessionLiveness.reset();
    resetEvents();
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
        stderrChunks.push(String(chunk));
        return true;
    }) as typeof process.stderr.write);
});

afterEach(() => {
    if (originalLogLevel === undefined) {
        delete process.env.MCP_LOG_LEVEL;
    } else {
        process.env.MCP_LOG_LEVEL = originalLogLevel;
    }
});

describe('调用预算', () => {
    it('pre-flight 的 ctx.mwn() 与工具本体共用同一份 150s 预算', async () => {
        const deadlines: Array<CallDeadline | undefined> = [];
        const tool = makeTool('test-tool', async (_args, ctx) => {
            deadlines.push(getRequestDeadline());
            return ctx.format.ok({ value: 1 });
        });
        const ctx = makeCtx({
            mwn: async () => {
                deadlines.push(getRequestDeadline());
                return fakeBot();
            },
        });

        const result = await call(tool, ctx, {});

        expect(result.isError).toBeFalsy();
        expect(deadlines).toHaveLength(2);
        expect(deadlines[0]).toBeDefined();
        expect(deadlines[1]).toBe(deadlines[0]);
        expect(deadlines[0]?.timeoutMs).toBe(WIKI_CALL_TIMEOUT_MS);
        expect(deadlines[0]?.phase).toBe('calling');
    });

    it('工具本体的 structuredContent 带上解析后的站点并同步到文本', async () => {
        const tool = makeTool('test-tool', async (_args, ctx) => ctx.format.ok({ value: 42 }));
        const ctx = makeCtx({ wikis: { [DEFAULT_KEY]: WIKI_CONFIG, [OTHER_KEY]: WIKI_CONFIG } });

        const result = await call(tool, ctx, { wiki: OTHER_KEY });

        expect(result.structuredContent).toEqual({ value: 42, wiki: OTHER_KEY });
        // 文本与结构化载荷保持一致，同样带上站点。
        expect(contentText(result)).toContain(OTHER_KEY);
    });
});

describe('早退路径的遥测', () => {
    it('未知站点：返回 invalid_input 并记录 tool_call', async () => {
        const tool = makeTool('test-tool', async () => {
            throw new Error('handle must not run');
        });
        const ctx = makeCtx();

        const result = await call(tool, ctx, { wiki: 'ghost' });

        expect(result.isError).toBe(true);
        expect(envelopeOf(result).category).toBe('invalid_input');
        const events = toolCallEvents();
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            tool: 'test-tool',
            wiki: 'ghost',
            outcome: 'invalid_input',
        });
    });

    it('能力拒绝：类别取自结果信封', async () => {
        const tool = makeTool('smw-query', async () => {
            throw new Error('handle must not run');
        });
        const ctx = makeCtx({ hasExtension: false, reachable: true });

        const result = await call(tool, ctx, {});

        expect(result.isError).toBe(true);
        expect(envelopeOf(result).category).toBe('invalid_input');
        const events = toolCallEvents();
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            tool: 'smw-query',
            wiki: DEFAULT_KEY,
            outcome: 'invalid_input',
        });
    });

    it('登录门未就绪：返回 authentication 并记录 tool_call', async () => {
        const tool = makeTool('test-tool', async () => {
            throw new Error('handle must not run');
        });
        const ctx = makeCtx({ login: { ready: false, message: 'need login' } });

        const result = await call(tool, ctx, {});

        expect(result.isError).toBe(true);
        expect(envelopeOf(result)).toMatchObject({
            category: 'authentication',
            message: 'need login',
        });
        const events = toolCallEvents();
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            tool: 'test-tool',
            wiki: DEFAULT_KEY,
            outcome: 'authentication',
        });
    });
});

describe('在途计数', () => {
    it('工具执行期间计数为 1，结束后归零', async () => {
        let observed = -1;
        const tool = makeTool('test-tool', async (_args, ctx) => {
            observed = count();
            return ctx.format.ok({});
        });

        await call(tool, makeCtx(), {});

        expect(observed).toBe(1);
        expect(count()).toBe(0);
    });

    it('早退路径同样成对增减', async () => {
        const tool = makeTool('test-tool', async () => {
            throw new Error('handle must not run');
        });

        await call(tool, makeCtx(), { wiki: 'ghost' });

        expect(count()).toBe(0);
    });
});

describe('遥测稳定性', () => {
    it('记录器抛错不影响成功结果', async () => {
        const tool = makeTool('test-tool', async (_args, ctx) => ctx.format.ok({ value: 1 }));
        // 非法日志级别会让 logger 在阈值解析时抛错，模拟遥测故障。
        process.env.MCP_LOG_LEVEL = 'not-a-level';

        const result = await call(tool, makeCtx(), {});

        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toEqual({ value: 1, wiki: DEFAULT_KEY });
    });

    it('记录器抛错也不影响早退错误结果', async () => {
        const tool = makeTool('test-tool', async () => {
            throw new Error('handle must not run');
        });
        process.env.MCP_LOG_LEVEL = 'not-a-level';

        const result = await call(tool, makeCtx(), { wiki: 'ghost' });

        expect(result.isError).toBe(true);
        expect(envelopeOf(result).category).toBe('invalid_input');
    });
});
