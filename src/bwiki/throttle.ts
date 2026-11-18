/**
 * 请求限速。
 *
 * 在每次请求前等待，而非失败后重试。遇到 567/514 时整个进程冷却 3 分钟。
 * 全进程共用一个队列，不按 wiki 区分。
 */

import { logger } from '../runtime/logger.ts';
import { getRequestDeadline } from '../runtime/requestContext.ts';

/** EdgeOne 的拦截状态码。 */
const EDGEONE_BLOCK_STATUS = new Set([567, 514]);

/** 567/514 后的冷却时长。 */
const COOLDOWN_MS = 3 * 60 * 1000;

/** 相邻两次请求的最小间隔。 */
const MIN_INTERVAL_MS = 1100;

interface ThrottleOptions {
    minIntervalMs?: number;
    cooldownMs?: number;
}

/** 串行队列：请求逐一发出，按 `minIntervalMs` 间隔。 */
class RequestThrottle {
    private readonly minIntervalMs: number;
    private readonly cooldownMs: number;

    /** 串行化：下一次请求必须等此 promise 完成。 */
    private tail: Promise<void> = Promise.resolve();

    /** 最近一次请求的发出时刻（非完成时刻）。 */
    private lastSentAt = 0;

    /** When the cooldown started, or 0 when there is none. */
    private cooldownUntil = 0;

    constructor(options: ThrottleOptions = {}) {
        this.minIntervalMs = options.minIntervalMs ?? MIN_INTERVAL_MS;
        this.cooldownMs = options.cooldownMs ?? COOLDOWN_MS;
    }

    /** True while a recorded block is still in force. */
    get inCooldown(): boolean {
        return Date.now() < this.cooldownUntil;
    }

    /**
     * 按间隔等待后执行 `send`。
     *
     * 调用方用 `reportBlock(status)` 回传状态。冷却作用于下一次请求。
     *
     * 队列在 `send` 结束之后才放行：否则并发调用者会在前一个请求仍在途中
     * 就完成间隔判断，实际发出时刻仍可能挤在一起。
     *
     * `signal` 用于取消等待：调用方取消后不必等完剩余冷却/间隔。
     */
    async run<T>(send: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        // 排队等待同时受调用方取消与本次调用的 150s 预算约束：
        // 冷却最长 180s，若无预算限制，等待会超出客户端超时。
        const deadline = getRequestDeadline();
        const effectiveSignal =
            signal === undefined
                ? deadline?.signal
                : deadline === undefined
                  ? signal
                  : AbortSignal.any([signal, deadline.signal]);

        // 排在已有等待之后，并发调用也会串行。
        const prior = this.tail;
        let release: () => void = () => {};
        this.tail = new Promise<void>(resolve => {
            release = resolve;
        });

        try {
            await prior;
            await this.waitTurn(effectiveSignal);
            // 在 send 之前记录：间隔按「上次开始到本次开始」计，
            // 慢请求的耗时不会额外拉长节流间隔。
            this.lastSentAt = Date.now();
            return await send();
        } finally {
            release();
        }
    }

    /** 记录被拦截，进入冷却。仅识别 567 与 514。 */
    reportBlock(status: number | undefined, context?: string): void {
        if (status === undefined || !EDGEONE_BLOCK_STATUS.has(status)) {
            return;
        }
        if (this.inCooldown) {
            return;
        }
        this.cooldownUntil = Date.now() + this.cooldownMs;
        logger.error(
            `BWiki blocked the request (HTTP ${status}). ` +
                `Pausing all requests for ${Math.round(this.cooldownMs / 1000)} seconds.` +
                (context ? ` Context: ${context}` : ''),
        );
    }

    /**
     * 记录请求完成。`run` 已在发送前记录发送时刻，这里保留以兼容既有调用方。
     */
    noteSent(): void {
        this.lastSentAt = Date.now();
    }

    /** 等待轮到本次请求。冷却等待可被 `signal` 中断。 */
    private async waitTurn(signal?: AbortSignal): Promise<void> {
        signal?.throwIfAborted();
        for (;;) {
            const now = Date.now();
            const cooldownRemaining = this.cooldownUntil - now;
            if (cooldownRemaining > 0) {
                // 用户决定：被拦截后仍然等待冷却，而非直接失败。
                await sleep(cooldownRemaining, signal);
                continue;
            }
            const sinceLast = now - this.lastSentAt;
            if (sinceLast < this.minIntervalMs) {
                await sleep(this.minIntervalMs - sinceLast, signal);
            }
            return;
        }
    }
}

/** 可被 `signal` 中断的 sleep；中断时以 signal 的原因拒绝。 */
const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
        if (signal?.aborted === true) {
            reject(signal.reason ?? new Error('Request aborted'));
            return;
        }
        const onAbort = (): void => {
            clearTimeout(timer);
            reject(signal?.reason ?? new Error('Request aborted'));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });

export { EDGEONE_BLOCK_STATUS, COOLDOWN_MS, MIN_INTERVAL_MS, RequestThrottle };
export type { ThrottleOptions };
