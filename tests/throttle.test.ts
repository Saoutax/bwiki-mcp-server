/**
 * 请求节流的单元测试。
 *
 * 两个容易写错的地方：
 *  - 队列若在 send 之前就放行，并发调用者在第一个请求还没回来时就会完成
 *    间隔判断，实际发出时刻仍可能撞在一起；
 *  - 间隔按「上次开始 → 本次开始」计，慢请求不应把间隔再拉长。
 * 冷却 180s 后继续等待（不是直接失败）是用户拍板的行为，也在这里锁定。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequestThrottle } from '../src/bwiki/throttle.ts';
import { withRequestFields } from '../src/runtime/requestContext.ts';

afterEach(() => {
    vi.useRealTimers();
});

describe('串行化', () => {
    it('前一个 send 结束前不放行队列', async () => {
        vi.useFakeTimers();
        const throttle = new RequestThrottle({ minIntervalMs: 0, cooldownMs: 60_000 });
        const order: string[] = [];

        const first = throttle.run(async () => {
            order.push('send1:start');
            await new Promise<void>(resolve => setTimeout(resolve, 30));
            order.push('send1:end');
        });
        const second = throttle.run(async () => {
            order.push('send2:start');
        });

        await vi.advanceTimersByTimeAsync(0);
        expect(order).toEqual(['send1:start']);

        await vi.advanceTimersByTimeAsync(29);
        expect(order).toEqual(['send1:start']);

        await vi.advanceTimersByTimeAsync(1);
        await first;
        await second;
        expect(order).toEqual(['send1:start', 'send1:end', 'send2:start']);
    });

    it('间隔按上次开始到本次开始计', async () => {
        vi.useFakeTimers();
        const throttle = new RequestThrottle({ minIntervalMs: 60, cooldownMs: 60_000 });
        const starts: number[] = [];

        const first = throttle.run(async () => {
            starts.push(Date.now());
            await new Promise<void>(resolve => setTimeout(resolve, 30));
        });
        const second = throttle.run(async () => {
            starts.push(Date.now());
        });

        await vi.advanceTimersByTimeAsync(30);
        await first;
        expect(starts).toHaveLength(1);

        // 若 lastSentAt 记在 send 结束之后，第二次要等到 +90ms 而不是 +60ms。
        await vi.advanceTimersByTimeAsync(29);
        expect(starts).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        await second;
        expect(starts).toHaveLength(2);
        expect(starts[1]! - starts[0]!).toBe(60);
    });
});

describe('冷却', () => {
    it('567/514 进入冷却，其他状态码不进入', () => {
        vi.useFakeTimers();
        const throttle = new RequestThrottle({ minIntervalMs: 0, cooldownMs: 1000 });
        throttle.reportBlock(500);
        expect(throttle.inCooldown).toBe(false);
        throttle.reportBlock(567);
        expect(throttle.inCooldown).toBe(true);
    });

    it('冷却期内等待而非直接失败', async () => {
        vi.useFakeTimers();
        const throttle = new RequestThrottle({ minIntervalMs: 0, cooldownMs: 180_000 });
        throttle.reportBlock(514);

        let sent = false;
        const pending = throttle.run(async () => {
            sent = true;
            return 'ok';
        });

        await vi.advanceTimersByTimeAsync(1);
        expect(sent).toBe(false);

        await vi.advanceTimersByTimeAsync(180_000);
        await expect(pending).resolves.toBe('ok');
        expect(sent).toBe(true);
    });

    it('冷却等待可被 signal 中断', async () => {
        vi.useFakeTimers();
        const throttle = new RequestThrottle({ minIntervalMs: 0, cooldownMs: 180_000 });
        throttle.reportBlock(567);

        const controller = new AbortController();
        let sent = false;
        const pending = throttle.run(async () => {
            sent = true;
        }, controller.signal);
        const rejection = expect(pending).rejects.toBeDefined();

        await vi.advanceTimersByTimeAsync(0);
        controller.abort();
        await rejection;
        expect(sent).toBe(false);
    });

    it('冷却等待受本次调用的预算约束', async () => {
        vi.useFakeTimers();
        const throttle = new RequestThrottle({ minIntervalMs: 0, cooldownMs: 180_000 });
        throttle.reportBlock(514);

        const controller = new AbortController();
        let sent = false;
        const pending = withRequestFields(
            {
                deadline: {
                    signal: controller.signal,
                    timeoutMs: 150_000,
                    phase: 'calling',
                },
            },
            () =>
                throttle.run(async () => {
                    sent = true;
                    return 'sent';
                }),
        );
        const rejection = expect(pending).rejects.toBeDefined();

        await vi.advanceTimersByTimeAsync(0);
        expect(sent).toBe(false);
        // 预算信号先中止：不能等满 180s 冷却。
        controller.abort();
        await rejection;
        expect(sent).toBe(false);
    });
});

describe('取消', () => {
    it('已中止的 signal 不会发出请求', async () => {
        const throttle = new RequestThrottle({ minIntervalMs: 0 });
        const controller = new AbortController();
        controller.abort();

        let sent = false;
        await expect(
            throttle.run(async () => {
                sent = true;
            }, controller.signal),
        ).rejects.toBeDefined();
        expect(sent).toBe(false);
    });

    it('等待被中断后队列仍可继续使用', async () => {
        const throttle = new RequestThrottle({ minIntervalMs: 0 });
        await expect(throttle.run(async () => 'warm')).resolves.toBe('warm');

        const controller = new AbortController();
        controller.abort();
        await expect(throttle.run(async () => 'never', controller.signal)).rejects.toBeDefined();

        // 若中断路径没有 release，这里会永远挂住。
        await expect(throttle.run(async () => 'after')).resolves.toBe('after');
    });
});
