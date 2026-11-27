import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import type { ApiParams, Mwn, ApiUploadResponse } from 'mwn';
import type { ApiUploadParams } from 'types-mediawiki-api';
import { UploadValidationError } from '../uploadGuard.ts';

/** action=upload 未成功时的归类，供 classifyError 映射到错误类别。 */
type UploadWarningCode = 'fileexists' | 'badfilename' | 'upload-warning';

/**
 * action=upload 成功的判据是 `result === 'Success'`；其余结果（多为 warnings）
 * 说明文件未被接受，继续当作成功会向调用方谎报上传完成。
 */
class UploadWarningError extends Error {
    public constructor(
        public readonly code: UploadWarningCode,
        message: string,
    ) {
        super(message);
        this.name = 'UploadWarningError';
    }
}

// MediaWiki 用 exists 告知同名文件已存在，部分版本给出 fileexists。
const FILE_EXISTS_WARNINGS = new Set(['exists', 'fileexists']);

// 站点侧对文件内容的校验失败。BWiki 上由 CheckImageUpload 执行：
// 它按内容判定图片类型，扩展名像图片并不会让它放行。
const IMAGE_VERIFICATION_WARNINGS = new Set(['verification-error', 'badimages']);

/**
 * 校验 action=upload 的结果，非 Success 时抛出带错误码的 UploadWarningError。
 *
 * 服务端上传与 wiki 侧 copy-upload 两条路径都走这里，避免两者判定不一致。
 */
const assertUploadResult = (upload: ApiUploadResponse): void => {
    // ApiUploadResponse 的字段是 any，先收窄再判断。
    const result: unknown = upload.result;
    if (result === 'Success') {
        return;
    }

    const warnings: unknown = upload.warnings;
    const warningNames =
        warnings !== null && typeof warnings === 'object' ? Object.keys(warnings) : [];
    let code: UploadWarningCode = 'upload-warning';
    if (warningNames.some(name => FILE_EXISTS_WARNINGS.has(name))) {
        code = 'fileexists';
    } else if (warningNames.includes('badfilename')) {
        code = 'badfilename';
    }

    const detail = warningNames.length > 0 ? warningNames.join(', ') : 'no warnings reported';
    const resultLabel = typeof result === 'string' ? result : 'unknown';
    const codeMessage = `Upload was not successful (result: ${resultLabel}; warnings: ${detail}).`;
    // 图片校验失败时补一句说明，避免调用方把「名字像图片」当成可以通过的理由。
    const verificationHint = warningNames.some(name => IMAGE_VERIFICATION_WARNINGS.has(name))
        ? " The file content did not pass the wiki's image verification (CheckImageUpload on BWiki); content that is not a real image is rejected even when its name looks like an image."
        : '';
    throw new UploadWarningError(code, codeMessage + verificationHint);
};

interface EditService {
    /** Wraps mwn.request with CSRF + tag injection + formatversion=2. For action:edit and similar. */
    submit(mwn: Mwn, params: Record<string, unknown>): Promise<unknown>;

    /**
     * Uploads a local file via a multipart action=upload. Reads the file into
     * memory and delegates to submitUploadFromBytes: mwn.upload builds the
     * multipart body from fs.createReadStream, whose length is unknown, and
     * BWiki hangs up on that. `text` 为 undefined 时表示不发送该参数（不覆盖文件页文本）。
     */
    submitUpload(
        mwn: Mwn,
        filepath: string,
        title: string,
        text: string | undefined,
        params: ApiUploadParams,
    ): Promise<ApiUploadResponse>;

    /** Uploads in-memory bytes via a multipart action=upload — parallel to submitUpload but without a local filepath. Injects CSRF token and tags; the bytes are passed to form-data as a Buffer (a plain Readable has no length and form-data rejects it with "Unknown stream"). `text` 为 undefined 时表示不发送该参数。 */
    submitUploadFromBytes(
        mwn: Mwn,
        data: Buffer,
        filename: string,
        title: string,
        text: string | undefined,
        params: ApiUploadParams,
    ): Promise<ApiUploadResponse>;

    /** Pure helper: returns options with the configured global tags injected. Used by mwn.create/delete/undelete callers. */
    applyTags<T extends Record<string, unknown>>(options: T): T;

    /**
     * 查询账号是否具备 `bot` 权限。探测失败不阻塞写入，结果按 Mwn 实例缓存。
     */
    botRight(mwn: Mwn): Promise<boolean | undefined>;
}

class EditServiceImpl implements EditService {
    /** 全局变更标签，来自配置的 `editTags`，空数组表示不附加标签。 */
    public constructor(private readonly tags: readonly string[]) {}

    private readonly botRightCache = new WeakMap<Mwn, Promise<boolean>>();

    public async botRight(mwn: Mwn): Promise<boolean | undefined> {
        let pending = this.botRightCache.get(mwn);
        if (!pending) {
            pending = this.queryBotRight(mwn);
            this.botRightCache.set(mwn, pending);
        }
        try {
            return await pending;
        } catch {
            // 失败的探测不缓存，以便下次重试。
            if (this.botRightCache.get(mwn) === pending) {
                this.botRightCache.delete(mwn);
            }
            return undefined;
        }
    }

    private async queryBotRight(mwn: Mwn): Promise<boolean> {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
        const response = (await mwn.request({
            action: 'query',
            meta: 'userinfo',
            uiprop: 'rights',
            formatversion: '2',
        })) as { query?: { userinfo?: { rights?: string[] } } };
        return response.query?.userinfo?.rights?.includes('bot') ?? false;
    }

    public async submit(mwn: Mwn, params: Record<string, unknown>): Promise<unknown> {
        const token = await mwn.getCsrfToken();
        const fullParams: Record<string, unknown> = { ...params, token, formatversion: '2' };
        if (this.tags.length > 0) {
            fullParams.tags = this.tags;
        }
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn ApiParams shape; we assemble fullParams to match the typed contract
        return mwn.request(fullParams as ApiParams);
    }

    public async submitUpload(
        mwn: Mwn,
        filepath: string,
        title: string,
        text: string | undefined,
        params: ApiUploadParams,
    ): Promise<ApiUploadResponse> {
        // 不调 mwn.upload：它用 fs.createReadStream 构造 multipart，而 Readable
        // 没有已知长度，BWiki 会挂断连接（约 55 秒后 socket hang up）。
        // 改成读成 Buffer 走 submitUploadFromBytes，长度已知，可正常发送。
        // 用 fs.open + fstat 而非 readFile：只接受普通文件，目录/设备文件等
        // 在读取前就以明确的错误拒绝，避免把错误留到 multipart 阶段。
        const handle = await open(filepath, 'r');
        try {
            const stats = await handle.stat();
            if (!stats.isFile()) {
                throw new UploadValidationError(`"${filepath}" is not a regular file.`);
            }
            const data = await handle.readFile();
            return await this.submitUploadFromBytes(
                mwn,
                data,
                basename(filepath),
                title,
                text,
                params,
            );
        } finally {
            await handle.close();
        }
    }

    public async submitUploadFromBytes(
        mwn: Mwn,
        data: Buffer,
        filename: string,
        title: string,
        text: string | undefined,
        params: ApiUploadParams,
    ): Promise<ApiUploadResponse> {
        const token = await mwn.getCsrfToken();
        // 参数顺序有意为之：params 先展开，关键字段随后覆盖，
        // 使调用方无法改写 action/file/filename/token 等关键字段。
        const fullParams: Record<string, unknown> = {
            ...params,
            action: 'upload',
            // 直接把 Buffer 交给 mwn 的 multipart `file` 字段：
            // form-data 可直接计算 Buffer 长度，而 Readable 无已知长度会被拒绝。
            file: { stream: data, name: filename },
            filename: title,
            ...(text === undefined ? {} : { text }),
            token,
        };
        if (this.tags.length > 0) {
            fullParams.tags = this.tags;
        }
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn ApiParams shape; the multipart `file` field is mwn's documented upload form
        const response = (await mwn.request(fullParams as ApiParams, {
            headers: { 'Content-Type': 'multipart/form-data' },
        })) as { upload: ApiUploadResponse };
        assertUploadResult(response.upload);
        return response.upload;
    }

    public applyTags<T extends Record<string, unknown>>(options: T): T {
        if (this.tags.length === 0) {
            return { ...options };
        }
        return { ...options, tags: this.tags };
    }
}

export { EditServiceImpl, UploadWarningError, assertUploadResult };
export type { EditService, UploadWarningCode };
