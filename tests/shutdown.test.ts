/**
 * 关闭流程的单元测试。
 *
 * 关键行为是顺序：stdio 必须先排空在途调用再关传输，否则正在提交的写会被
 * 半路砍断。这里用事件序列断言顺序，不依赖真实 socket 或进程。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    registerShutdownHandlers,
    resolveShutdownGrace,
    type ShutdownDeps,
} from '../src/runtime/shutdown.ts';

const DEFAULT_GRACE_MS = 10_000;

interface FakeProcess {
    readonly proc: NodeJS.Process;
    readonly exits: number[];
    readonly fire: (signal: 'SIGTERM' | 'SIGINT') => void;
}

const createProcess = (): FakeProcess => {
    const handlers = new Map<string, () => void>();
    const exits: number[] = [];
    const proc = {
        on: (event: string, handler: () => void): void => {
            handlers.set(event, handler);
        },
        exit: (code?: number): void => {
            exits.push(code ?? 0);
        },
    };
    return {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- 只实现关闭路径用到的两个成员
        proc: proc as unknown as NodeJS.Process,
        exits,
        fire: signal => handlers.get(signal)?.(),
    };
};

beforeEach(() => {
    // 关闭流程会写结构化日志；测试里不关心。
    vi.spyOn(process.stderr, 'write').mockImplementation(
        (() => true) as typeof process.stderr.write,
    );
});

describe('resolveShutdownGrace', () => {
    it('缺省为 10 秒', () => {
        expect(resolveShutdownGrace({})).toBe(DEFAULT_GRACE_MS);
    });

    it('接受 0 与合法整数', () => {
        expect(resolveShutdownGrace({ MCP_SHUTDOWN_GRACE_MS: '0' })).toBe(0);
        expect(resolveShutdownGrace({ MCP_SHUTDOWN_GRACE_MS: '2500' })).toBe(2500);
        expect(resolveShutdownGrace({ MCP_SHUTDOWN_GRACE_MS: '600000' })).toBe(600000);
    });

    it('非法值回落默认值', () => {
        for (const raw of ['', 'abc', '-1', '1.5', '600001']) {
            expect(resolveShutdownGrace({ MCP_SHUTDOWN_GRACE_MS: raw })).toBe(DEFAULT_GRACE_MS);
        }
    });
});

describe('stdio 关闭顺序', () => {
    it('先排空在途调用，再关传输，干净排空以 0 退出', async () => {
        const events: string[] = [];
        const fake = createProcess();
        const deps: ShutdownDeps = {
            transport: 'stdio',
            graceMs: DEFAULT_GRACE_MS,
            inFlight: {
                count: (): number => {
                    events.push('drain-check');
                    return 0;
                },
            },
            stdioTransport: {
                close: async (): Promise<void> => {
                    events.push('close');
                },
            },
            process: fake.proc,
        };
        registerShutdownHandlers(deps);

        fake.fire('SIGTERM');
        await vi.waitFor(() => {
            expect(fake.exits).toHaveLength(1);
        });

        expect(fake.exits).toEqual([0]);
        // close 之前必须已有排空判定：关闭传输不能先于在途统计。
        const closeIndex = events.indexOf('close');
        expect(closeIndex).toBeGreaterThan(0);
        expect(events.slice(0, closeIndex)).toEqual(Array(closeIndex).fill('drain-check'));
    });

    it('宽限期用尽时仍会关闭传输，并以 1 退出', async () => {
        const events: string[] = [];
        const fake = createProcess();
        const deps: ShutdownDeps = {
            transport: 'stdio',
            graceMs: 0,
            inFlight: { count: (): number => 1 },
            stdioTransport: {
                close: async (): Promise<void> => {
                    events.push('close');
                },
            },
            process: fake.proc,
        };
        registerShutdownHandlers(deps);

        fake.fire('SIGTERM');
        await vi.waitFor(() => {
            expect(fake.exits).toHaveLength(1);
        });

        expect(fake.exits).toEqual([1]);
        expect(events).toContain('close');
    });

    it('重复信号直接以 1 退出', async () => {
        const fake = createProcess();
        registerShutdownHandlers({
            transport: 'stdio',
            graceMs: DEFAULT_GRACE_MS,
            inFlight: { count: (): number => 0 },
            stdioTransport: { close: async (): Promise<void> => undefined },
            process: fake.proc,
        });

        fake.fire('SIGTERM');
        await vi.waitFor(() => {
            expect(fake.exits).toHaveLength(1);
        });
        fake.fire('SIGINT');
        await vi.waitFor(() => {
            expect(fake.exits).toHaveLength(2);
        });

        expect(fake.exits).toEqual([0, 1]);
    });
});

describe('http 关闭顺序', () => {
    it('保持原行为：先关服务器，排空后关 handler', async () => {
        const calls: string[] = [];
        const fake = createProcess();
        const httpServer = {
            close: (): void => {
                calls.push('http-close');
            },
            closeIdleConnections: (): void => {
                calls.push('idle-connections');
            },
        };
        registerShutdownHandlers({
            transport: 'http',
            graceMs: DEFAULT_GRACE_MS,
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- 只实现关闭路径用到的成员
            httpServer: httpServer as unknown as ShutdownDeps['httpServer'],
            mcpHandler: {
                close: async (): Promise<void> => {
                    calls.push('handler-close');
                },
            },
            inFlight: { count: (): number => 0 },
            process: fake.proc,
        });

        fake.fire('SIGTERM');
        await vi.waitFor(() => {
            expect(fake.exits).toHaveLength(1);
        });

        expect(fake.exits).toEqual([0]);
        expect(calls).toEqual(['http-close', 'idle-connections', 'handler-close']);
    });
});
