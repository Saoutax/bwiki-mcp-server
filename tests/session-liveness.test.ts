/**
 * 写守卫的单元测试：身份没了，写操作是否被拦住。
 *
 * 运行时那一路（会话在启动后失效）无法从进程外制造：cookie 已在 mwn 的内存
 * jar 里，改会话文件对运行中的进程没有影响。所以守卫在真正做决定的地方测：
 * sessionLiveness 面对一个 userinfo 报出 IP 而不是 UID 的 bot —— 这正是
 * BWiki 对过期 cookie 的响应（实测，不是假设：启动期探针看到死会话下
 * name=203.0.113.7）。
 *
 * 覆盖点：
 *
 *  1. UID 通过，守卫不挡健康写入；
 *  2. IP 判死并记录原因；
 *  3. 一旦判死，结论是黏的——后续调用不再探测、也不放行；
 *  4. 传输失败不算死亡，因为 wiki 不可达与凭证有效性无关。
 *
 * wiki key 只是标签（bot 是假的），故用字面量，不读 config.json。
 */

import type { Mwn } from 'mwn';
import { beforeEach, describe, expect, it } from 'vitest';
import { isBilibiliUid, SessionExpiredError, sessionLiveness } from '../src/bwiki/liveness.ts';

const WIKI_KEY = 'test-wiki';

/** 一个 userinfo 报出所给内容的 bot 替身；传 Error 则抛出它。 */
const fakeBot = (userinfo: unknown): Mwn =>
    ({
        userinfo: async () => {
            if (userinfo instanceof Error) {
                throw userinfo;
            }
            return userinfo;
        },
    }) as unknown as Mwn;

/** 捕获断言抛出的错误，用于检查类型而不是只检查「有抛出」。 */
const capture = async (promise: Promise<unknown>): Promise<unknown> => {
    try {
        await promise;
        return undefined;
    } catch (err) {
        return err;
    }
};

// 进程级单例：每条用例从干净状态开始，否则判死后无法回头。
beforeEach(() => {
    sessionLiveness.reset();
});

describe('会话存活守卫', () => {
    it('UID 身份放行', async () => {
        await sessionLiveness.assertAlive(fakeBot({ name: '100000000' }), WIKI_KEY);
        expect(sessionLiveness.deathReason).toBeNull();
    });

    it('isBilibiliUid 判定纯数字', () => {
        expect(isBilibiliUid('100000000')).toBe(true);
        expect(isBilibiliUid('203.0.113.7')).toBe(false);
    });

    it('传输失败不计为登出', async () => {
        const err = await capture(
            sessionLiveness.assertAlive(fakeBot(new Error('ECONNRESET')), WIKI_KEY),
        );
        expect(err).toBeInstanceOf(Error);
        expect(err).not.toBeInstanceOf(SessionExpiredError);
        expect(sessionLiveness.deathReason).toBeNull();
    });

    it('匿名身份（IP）判为失效', async () => {
        const err = await capture(
            sessionLiveness.assertAlive(fakeBot({ name: '203.0.113.7' }), WIKI_KEY),
        );
        expect(err).toBeInstanceOf(SessionExpiredError);
        expect(sessionLiveness.deathReason).not.toBeNull();
    });

    it('死亡处理器被调用', async () => {
        let deathRecorded: string | null = null;
        sessionLiveness.setDeathHandler(reason => {
            deathRecorded = reason;
        });
        await capture(sessionLiveness.assertAlive(fakeBot({ name: '203.0.113.7' }), WIKI_KEY));
        expect(deathRecorded).toEqual(expect.any(String));
    });

    it('原因里点明要重新登录', async () => {
        await capture(sessionLiveness.assertAlive(fakeBot({ name: '203.0.113.7' }), WIKI_KEY));
        expect(sessionLiveness.deathReason).toMatch(/bwiki-login/);
    });

    it('失效后结论保持', async () => {
        await capture(sessionLiveness.assertAlive(fakeBot({ name: '203.0.113.7' }), WIKI_KEY));

        // 第二次调用若重新探测并放行，就说明「判死」没有真正生效。
        let probedAgain = false;
        const watchingBot = {
            userinfo: async () => {
                probedAgain = true;
                return { name: '100000000' };
            },
        } as unknown as Mwn;

        const err = await capture(sessionLiveness.assertAlive(watchingBot, WIKI_KEY));
        expect(err).toBeInstanceOf(SessionExpiredError);
        expect(probedAgain).toBe(false);
    });
});
