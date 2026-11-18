/**
 * stdout 守卫的单元测试。
 *
 * stdio 下 stdout 只承载 JSON-RPC 帧。仅断言「代码调了 guard」不够：必须看到
 * console 与 mwn 的输出确实没有出现在 stdout，而是变成结构化 stderr 事件。
 *
 * 第一个用例负责安装守卫（本文件内只装一次，也顺带验证幂等），后续用例在
 * 已安装状态下检查输出去向。mock 恢复由 vitest 的 restoreMocks 负责。
 */

import { Mwn } from 'mwn';
import { message as mwnLogMessage } from 'mwn/build/log.js';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { guardStdout } from '../src/runtime/stdoutGuard.ts';

const originalConsole = globalThis.console;
const originalLogLevel = process.env.MCP_LOG_LEVEL;

let stdoutChunks: string[] = [];
let stderrChunks: string[] = [];

beforeEach(() => {
    process.env.MCP_LOG_LEVEL = 'debug';
    stdoutChunks = [];
    stderrChunks = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
        stdoutChunks.push(String(chunk));
        return true;
    }) as typeof process.stdout.write);
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

afterAll(() => {
    // 守卫替换了全局 console，测试进程用完要还原。
    globalThis.console = originalConsole;
});

/** stderr 上以 `stray_stdout` 事件记录的行。 */
const strayStdoutTexts = (): string[] =>
    stderrChunks
        .join('')
        .split('\n')
        .filter(line => line.trim() !== '')
        .map(line => JSON.parse(line) as { event?: string; text?: string })
        .filter(entry => entry.event === 'stray_stdout')
        .map(entry => entry.text ?? '');

describe('stdout 守卫', () => {
    it('幂等安装，并把 mwn 日志流指向非 stdout 的写端', () => {
        const loggingSpy = vi.spyOn(Mwn, 'setLoggingConfig');
        const consoleBefore = globalThis.console;

        guardStdout();
        guardStdout();

        expect(loggingSpy).toHaveBeenCalledTimes(1);
        const options = loggingSpy.mock.calls[0]?.[0];
        expect(options?.stream).toBeDefined();
        expect(options?.stream).not.toBe(process.stdout);
        expect(globalThis.console).not.toBe(consoleBefore);
    });

    it('console.log 不写入 stdout，而是记为 stray_stdout 事件', () => {
        console.log('console-stray-line');

        expect(stdoutChunks.join('')).toBe('');
        expect(strayStdoutTexts()).toContainEqual(expect.stringContaining('console-stray-line'));
    });

    it('mwn 日志不写入 stdout，而是记为 stray_stdout 事件', () => {
        mwnLogMessage('[i] mwn-stray-line');

        expect(stdoutChunks.join('')).toBe('');
        expect(strayStdoutTexts()).toContainEqual(expect.stringContaining('mwn-stray-line'));
    });

    it('告警文本被逐行记录，不丢内容', () => {
        mwnLogMessage('first-mwn-line\nsecond-mwn-line');

        expect(stdoutChunks.join('')).toBe('');
        const texts = strayStdoutTexts();
        expect(texts).toContainEqual(expect.stringContaining('first-mwn-line'));
        expect(texts).toContainEqual(expect.stringContaining('second-mwn-line'));
    });
});
