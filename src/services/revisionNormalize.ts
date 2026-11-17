interface ApiRevisionLike {
    revid?: number;
    timestamp?: string;
    contentmodel?: string;
    size?: number;
    content?: string;
    slots?: { main?: { contentmodel?: string; content?: string; size?: number } };
}

type NormalisedRevision = Omit<ApiRevisionLike, 'slots'> & {
    contentmodel?: string;
    content?: string;
    size?: number;
};

interface RevisionNormalizer {
    normalise(rev: ApiRevisionLike): NormalisedRevision;
}

class RevisionNormalizerImpl implements RevisionNormalizer {
    public normalise(rev: ApiRevisionLike): NormalisedRevision {
        const { slots, ...base } = rev;
        if (slots?.main) {
            return { ...base, ...slots.main };
        }
        return base;
    }
}

export { RevisionNormalizerImpl };
export type { ApiRevisionLike, NormalisedRevision, RevisionNormalizer };
