/**
 * 会话文件的读写。
 *
 * 文件含长期有效的 bilibili 凭证，故写成仅属主可读（0o600），
 * 且先写同目录临时文件再 rename 覆盖，避免中途失败留下半个文件。
 */

import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** 会话文件的载荷，字段与 bwiki-login 写入的格式一致。 */
interface SessionRecord {
    passportCookie: string;
    wikiCookie: string;
    userId: string;
    savedAt: number;
}

/**
 * 原子写入会话文件。
 *
 * 临时文件与目标同目录，rename 在同一文件系统内才具备原子性。
 * 目录按需创建，权限 0o700：会话文件不该被同机其他用户读到。
 */
const writeSessionFile = async (file: string, record: SessionRecord): Promise<void> => {
    const dir = dirname(file);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = join(
        dir,
        `.${basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
    );
    try {
        await writeFile(temp, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 });
        await rename(temp, file);
    } catch (err) {
        // 失败时清掉临时文件，不留凭证副本。
        await rm(temp, { force: true }).catch(() => undefined);
        throw err;
    }
};

/**
 * 删除会话文件。不吞异常，由调用方决定「文件不存在」是否算失败：
 * `rm` 的 `force` 已使缺失文件不报错。
 */
const removeSessionFile = async (file: string): Promise<void> => {
    await rm(file, { force: true });
};

export { removeSessionFile, writeSessionFile };
export type { SessionRecord };
