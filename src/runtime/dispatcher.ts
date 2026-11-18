import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ZodRawShape, z } from 'zod';
import { sessionLiveness, SessionExpiredError } from '../bwiki/liveness.ts';
import type { ErrorCategory } from '../errors/classifyError.ts';
import { errorMessage } from '../errors/isErrnoException.ts';
import { applySpecialCase } from '../errors/specialCases.ts';
import { WikiTimeoutError } from '../errors/wikiTimeoutError.ts';
import { structuredResult } from '../results/response.ts';
import { callDeadline, WIKI_CALL_TIMEOUT_MS } from './callDeadline.ts';
import { monotonicNow } from './clock.ts';
import type { ToolContext } from './context.ts';
import { begin, end } from './inFlight.ts';
import {
    emitToolCall,
    extractUpstreamStatus,
    parseEnvelope,
    type EmitToolCallOptions,
    type ToolOutcome,
} from './instrument.ts';
import { getRequestSignal, getRuntimeToken, withRequestFields } from './requestContext.ts';
import type { Tool } from './tool.ts';
import { isWikiScoped, normalizeWikiArg } from './wikiArg.ts';
import { checkWikiCapability, isWriteTool } from './wikiCapability.ts';

// 超时可能发生在写入提交前或之后，服务端无法区分。
// 调用方不可假定追加未生效而重放，否则内容会重复。
const WRITE_TIMEOUT_CAVEAT =
    '. The change may or may not have been applied — check the wiki before retrying';

const dispatch =
    <TSchema extends ZodRawShape, TCtx extends ToolContext = ToolContext>(
        tool: Tool<TSchema, TCtx>,
        ctx: TCtx,
    ): ((args: z.infer<z.ZodObject<TSchema>>) => Promise<CallToolResult>) =>
    async args => {
        // 在途计数覆盖整条调用路径：早退与抛错都成对结束，
        // 使 shutdown 只等待真正还在跑的调用。
        begin();
        try {
            return await dispatchCall(tool, ctx, args);
        } finally {
            end();
        }
    };

const dispatchCall = async <TSchema extends ZodRawShape, TCtx extends ToolContext>(
    tool: Tool<TSchema, TCtx>,
    ctx: TCtx,
    args: z.infer<z.ZodObject<TSchema>>,
): Promise<CallToolResult> => {
    const started = monotonicNow();
    // 一次调用只有一份总预算：pre-flight 的 ctx.mwn() 与工具本体共用，
    // 否则两者各起一份 150s，实际总耗时翻倍。
    return withRequestFields({ deadline: callDeadline(WIKI_CALL_TIMEOUT_MS, 'calling') }, () =>
        dispatchBody(tool, ctx, args, started),
    );
};

const dispatchBody = async <TSchema extends ZodRawShape, TCtx extends ToolContext>(
    tool: Tool<TSchema, TCtx>,
    ctx: TCtx,
    args: z.infer<z.ZodObject<TSchema>>,
    started: number,
): Promise<CallToolResult> => {
    // 解析本次调用的目标站点。
    let resolvedKey: string | undefined;
    if (isWikiScoped(tool)) {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the `wiki` field is merged into the schema by register(); not in the static TSchema
        const raw = (args as { wiki?: unknown }).wiki;
        // 规范化后为空视为未传，回落默认站点。
        const normalized = typeof raw === 'string' ? normalizeWikiArg(raw) : '';
        const requested = normalized !== '' ? normalized : undefined;
        resolvedKey = requested ?? ctx.activeWiki.getDefaultKey();
        const wikiKey = telemetryWikiKey(resolvedKey, ctx);
        if (!ctx.wikis.get(resolvedKey)) {
            const configured = Object.keys(ctx.wikis.getAll());
            const result = ctx.format.invalidInput(
                `Wiki "${resolvedKey}" not found. Configured wikis: ${configured.join(', ')}`,
            );
            emitEarlyCall(tool.name, args, started, result, 'invalid_input', wikiKey);
            return result;
        }
        const guardError = await checkWikiCapability(tool.name, resolvedKey, ctx);
        if (guardError) {
            // 拒绝结果自带信封类别；缺失时按能力门槛的默认语义报为无权限。
            const category = envelopeCategory(guardError) ?? 'permission_denied';
            emitEarlyCall(tool.name, args, started, guardError, category, wikiKey);
            return guardError;
        }
    }

    const body = async (): Promise<CallToolResult> => {
        // 一切 wiki 操作都要求已登录：无会话时启动登录流程，本次调用返回提示。
        if (resolvedKey !== undefined) {
            const gate = ctx.loginGate.ensureLoggedIn();
            if (!gate.ready) {
                const result = ctx.format.error('authentication', gate.message);
                emitEarlyCall(tool.name, args, started, result, 'authentication', resolvedKey);
                return result;
            }
            const expired = await guardSessionAlive(ctx, resolvedKey);
            if (expired) {
                const category = envelopeCategory(expired) ?? 'upstream_failure';
                emitEarlyCall(tool.name, args, started, expired, category, resolvedKey);
                return expired;
            }
        }
        return runDispatchInner(tool, ctx, args, started, resolvedKey);
    };

    if (resolvedKey !== undefined) {
        return withRequestFields({ wikiKey: resolvedKey }, body);
    }
    return body();
};

/** 遥测里的站点：解析出的 key，未指定 wiki 时用默认站点。 */
const telemetryWikiKey = (resolvedKey: string | undefined, ctx: ToolContext): string =>
    resolvedKey ?? ctx.activeWiki.get().key;

const firstText = (result: CallToolResult): string | undefined => {
    const first = result.content[0];
    return first !== undefined && 'text' in first && typeof first.text === 'string'
        ? first.text
        : undefined;
};

const envelopeCategory = (result: CallToolResult): ErrorCategory | undefined =>
    parseEnvelope(firstText(result)).category;

/** 遥测不得影响工具调用：记录器抛错（如日志级别非法）时吞掉。 */
const emitSafely = <TArgs>(options: EmitToolCallOptions<TArgs>): void => {
    try {
        emitToolCall(options);
    } catch {
        // 记录失败不应改变调用结果。
    }
};

/** 早退路径同样记一条 tool_call，否则统计里只剩成功与抛错两种。 */
const emitEarlyCall = <TArgs>(
    toolName: string,
    args: TArgs,
    started: number,
    result: CallToolResult,
    category: ErrorCategory,
    wikiKey: string,
): void => {
    const env = parseEnvelope(firstText(result));
    emitSafely({
        toolName,
        args,
        started,
        result,
        outcome: category,
        upstreamStatus: undefined,
        errorMessage: env.message,
        runtimeToken: getRuntimeToken(),
        wikiKey,
        bilibiliUid: sessionLiveness.identity ?? undefined,
    });
};

/**
 * 确认会话有效。返回 undefined 表示放行。
 *
 * 会话失效时先尝试触发一次登录流程：登录成功则放行本次调用，
 * 用户尚未完成登录则返回 authentication 错误，不断开连接。
 */
const guardSessionAlive = async (
    ctx: ToolContext,
    wikiKey: string,
): Promise<CallToolResult | undefined> => {
    // 已记录失效时不再探测，直接触发登录流程。
    const known = sessionLiveness.deathReason;
    if (known !== null) {
        return relogin(ctx);
    }

    let bot;
    try {
        bot = await ctx.mwn(wikiKey);
    } catch (err) {
        // 取不到客户端属于连接问题，非登出。
        return ctx.format.error('upstream_failure', errorMessage(err));
    }

    try {
        await sessionLiveness.assertAlive(bot, wikiKey);
        return undefined;
    } catch (err) {
        if (err instanceof SessionExpiredError) {
            return relogin(ctx);
        }
        return ctx.format.error('upstream_failure', errorMessage(err));
    }
};

/** 会话失效时强制重新登录。登录流程已启动则返回等待提示。 */
const relogin = async (ctx: ToolContext): Promise<CallToolResult | undefined> => {
    const gate = ctx.loginGate.restartLogin();
    return ctx.format.error('authentication', gate.message);
};

const runDispatchInner = async <TSchema extends ZodRawShape, TCtx extends ToolContext>(
    tool: Tool<TSchema, TCtx>,
    ctx: TCtx,
    args: z.infer<z.ZodObject<TSchema>>,
    started: number,
    resolvedKey?: string,
): Promise<CallToolResult> => {
    let outcome: ToolOutcome = 'success';
    let errorText: string | undefined;
    let upstreamStatus: number | undefined;
    let result: CallToolResult;

    try {
        // 预算已在 dispatchCall 放入请求作用域，此处不再新建。
        result = await tool.handle(args, ctx);
        if (result.isError) {
            const env = parseEnvelope(firstText(result));
            // 信封缺失或无法解析时按 upstream_failure 处理，避免误报为成功。
            outcome = env.category ?? 'upstream_failure';
            if (env.message) {
                errorText = env.message;
            }
        }
    } catch (err) {
        const classified = ctx.errors.classify(err);
        const overridden = applySpecialCase(tool.name, classified, err);

        outcome = overridden.category;
        upstreamStatus = extractUpstreamStatus(err);

        // 特例消息原样使用，否则加 "Failed to <verb>: " 前缀。
        const rawMessage = errorMessage(err);
        const tailored = overridden.message !== rawMessage;
        const verb = tool.failureVerb ?? tool.name;
        let finalMessage = tailored
            ? overridden.message
            : `Failed to ${verb}: ${overridden.message}`;
        if (err instanceof WikiTimeoutError && err.phase === 'calling' && isWriteTool(tool)) {
            finalMessage += WRITE_TIMEOUT_CAVEAT;
        }
        errorText = finalMessage;

        // 取消的调用表现为格式错误的响应而非中止，按取消归类并丢弃结果。
        if (getRequestSignal()?.aborted === true) {
            ctx.logger.info('Tool call cancelled', { tool: tool.name });
        } else {
            ctx.logger.error('Tool failed', {
                tool: tool.name,
                category: overridden.category,
                code: overridden.code,
            });
        }
        result = ctx.format.error(overridden.category, finalMessage, overridden.code);
    }

    // 覆盖抛出与工具自行捕获两种失败路径。
    if (outcome !== 'success' && getRequestSignal()?.aborted === true) {
        outcome = 'cancelled';
    }

    // 用 structuredResult 重包，使 content[0].text 与 structuredContent 保持一致。
    if (
        resolvedKey !== undefined &&
        !result.isError &&
        typeof result.structuredContent === 'object' &&
        result.structuredContent !== null &&
        !Array.isArray(result.structuredContent)
    ) {
        result = structuredResult({ ...result.structuredContent, wiki: resolvedKey });
    }

    emitSafely({
        toolName: tool.name,
        target: tool.target,
        args,
        started,
        result,
        outcome,
        upstreamStatus,
        errorMessage: errorText,
        runtimeToken: getRuntimeToken(),
        wikiKey: telemetryWikiKey(resolvedKey, ctx),
        bilibiliUid: sessionLiveness.identity ?? undefined,
    });

    return result;
};

export { dispatch };
