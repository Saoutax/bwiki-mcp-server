import type { Mwn } from 'mwn';

/** 已提交、等待审核的版本。 */
interface PendingModeration {
    readonly wikitext: string;
    readonly comment?: string;
}

interface ModerationService {
    /** 是否启用写入后的自动检测。 */
    readonly enabled: boolean;
    /** 账号是否因 `skip-moderation` 权限而免于审核；查询失败时返回 undefined。 */
    exempt(mwn: Mwn): Promise<boolean | undefined>;
    /** 读取当前账号在该页面的待审版本，没有时返回 undefined。 */
    pending(mwn: Mwn, title: string, section?: number): Promise<PendingModeration | undefined>;
    /** 写入后的检测：关闭、免审或请求失败时都返回 undefined。 */
    afterWrite(mwn: Mwn, title: string): Promise<PendingModeration | undefined>;
}

/**
 * 写入被审核时的统一提示。
 *
 * 模型常把「成功但没有新版本号」当成失败并重复提交，
 * 所以这里同时说明页面不会立刻变化、不要重试以及如何复核提交内容。
 */
const MODERATION_WRITE_NOTICE =
    'This edit is awaiting moderation. The page keeps showing its old content until a reviewer ' +
    'approves it, and the pending edit does not advance the page latest revision ID. Do not ' +
    'resubmit because a read returns the old text; to review what was submitted, read the page ' +
    'with get-page and includePending: true.';

interface UserinfoRightsResponse {
    query?: { userinfo?: { rights?: unknown } };
}

interface ModerationPreloadResponse {
    query?: {
        moderationpreload?: { wikitext?: unknown; comment?: unknown; missing?: unknown };
    };
}

class ModerationServiceImpl implements ModerationService {
    private readonly exemptCache = new WeakMap<Mwn, Promise<boolean>>();

    public constructor(public readonly enabled: boolean) {}

    public async exempt(mwn: Mwn): Promise<boolean | undefined> {
        let pending = this.exemptCache.get(mwn);
        if (!pending) {
            pending = this.queryExempt(mwn);
            this.exemptCache.set(mwn, pending);
        }
        try {
            return await pending;
        } catch {
            // 失败的探测不缓存，以便下次重试。
            if (this.exemptCache.get(mwn) === pending) {
                this.exemptCache.delete(mwn);
            }
            return undefined;
        }
    }

    public async pending(
        mwn: Mwn,
        title: string,
        section?: number,
    ): Promise<PendingModeration | undefined> {
        const params: Record<string, string | number | boolean> = {
            action: 'query',
            prop: 'moderationpreload',
            mptitle: title,
            mpmode: 'wikitext',
            formatversion: '2',
        };
        if (section !== undefined) {
            params.mpsection = section;
        }
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
        const response = (await mwn.request(params)) as ModerationPreloadResponse;
        const preload = response.query?.moderationpreload;
        // `missing` 表示该页没有自己的待审版本，字段值为空串。
        if (preload === undefined || preload === null || 'missing' in preload) {
            return undefined;
        }
        const { wikitext, comment } = preload;
        if (typeof wikitext !== 'string') {
            return undefined;
        }
        return {
            wikitext,
            ...(typeof comment === 'string' && comment !== '' ? { comment } : {}),
        };
    }

    public async afterWrite(mwn: Mwn, title: string): Promise<PendingModeration | undefined> {
        if (!this.enabled) {
            return undefined;
        }
        // 有 skip-moderation 的账号不会进入审核队列，省掉这次预读请求。
        if ((await this.exempt(mwn)) === true) {
            return undefined;
        }
        try {
            return await this.pending(mwn, title);
        } catch {
            // 检测失败只降级为现有行为，不影响写入结果。
            return undefined;
        }
    }

    private async queryExempt(mwn: Mwn): Promise<boolean> {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
        const response = (await mwn.request({
            action: 'query',
            meta: 'userinfo',
            uiprop: 'rights',
            formatversion: '2',
        })) as UserinfoRightsResponse;
        const rights = response.query?.userinfo?.rights;
        return Array.isArray(rights) && rights.includes('skip-moderation');
    }
}

export { MODERATION_WRITE_NOTICE, ModerationServiceImpl };
export type { ModerationService, PendingModeration };
