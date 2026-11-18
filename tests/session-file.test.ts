/**
 * 会话文件收尾的单元测试：原子写、权限、临时文件清理。
 *
 * 这些行为在真实登录流程里看不出来——写坏了才会暴露，所以单独测。
 */

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    removeSessionFile,
    writeSessionFile,
    type SessionRecord,
} from '../src/bwiki/sessionFile.ts';

let dir: string;

const record = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
    passportCookie: 'SESSDATA=abc; bili_jct=token',
    wikiCookie: 'gamecenter_wiki=sess',
    userId: '100000000',
    savedAt: 1_700_000_000_000,
    ...overrides,
});

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bwiki-session-file-'));
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe('writeSessionFile', () => {
    it('按需创建多级目录并写入 JSON', async () => {
        const file = join(dir, 'nested', 'deeper', 'session.json');
        await writeSessionFile(file, record());

        expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(record());
    });

    it('成功后目录里只剩下会话文件（无临时文件残留）', async () => {
        const file = join(dir, 'session.json');
        await writeSessionFile(file, record());

        expect(await readdir(dirname(file))).toEqual(['session.json']);
    });

    it('重复写入覆盖旧内容且不留下多份文件', async () => {
        const file = join(dir, 'session.json');
        await writeSessionFile(file, record());
        await writeSessionFile(file, record({ userId: '200000000' }));

        expect(JSON.parse(await readFile(file, 'utf8')).userId).toBe('200000000');
        expect(await readdir(dir)).toEqual(['session.json']);
    });

    it('写入失败时清掉临时文件并抛出原错误', async () => {
        const file = join(dir, 'session.json');
        // 循环引用让 JSON.stringify 抛错：已生成临时文件名但未写入内容。
        const circular: Record<string, unknown> = {};
        circular.self = circular;

        await expect(
            writeSessionFile(file, circular as unknown as SessionRecord),
        ).rejects.toThrow();
        expect(await readdir(dir)).toEqual([]);
    });

    it.skipIf(process.platform === 'win32')('文件权限为 0600，目录权限为 0700', async () => {
        const file = join(dir, 'nested', 'session.json');
        await writeSessionFile(file, record());

        expect((await stat(file)).mode & 0o777).toBe(0o600);
        expect((await stat(dirname(file))).mode & 0o777).toBe(0o700);
    });
});

describe('removeSessionFile', () => {
    it('删除已存在的会话文件', async () => {
        const file = join(dir, 'session.json');
        await writeSessionFile(file, record());

        await removeSessionFile(file);
        expect(existsSync(file)).toBe(false);
    });

    it('文件不存在时不抛出', async () => {
        await expect(removeSessionFile(join(dir, 'missing.json'))).resolves.toBeUndefined();
    });
});
