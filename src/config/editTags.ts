/**
 * 校验 `editTags`：全局变更标签列表。
 *
 * 标签名是否合法、站点是否已定义、账号是否有 `changetags` 权限，
 * 都交由 wiki 在写入时判定；此处只做类型校验与规范化。
 */
const resolveEditTags = (raw: unknown): readonly string[] => {
    if (raw === undefined || raw === null) {
        return [];
    }
    if (!Array.isArray(raw)) {
        throw new Error('Config error: "editTags" must be an array of strings');
    }
    const tags: string[] = [];
    for (const entry of raw) {
        if (typeof entry !== 'string') {
            throw new Error('Config error: "editTags" entries must be strings');
        }
        const tag = entry.trim();
        if (tag === '') {
            throw new Error('Config error: "editTags" entries must be non-empty strings');
        }
        if (!tags.includes(tag)) {
            tags.push(tag);
        }
    }
    return tags;
};

export { resolveEditTags };
