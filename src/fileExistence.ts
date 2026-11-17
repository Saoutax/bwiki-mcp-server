import type { ApiPage, Mwn } from 'mwn';

class FileNotFoundError extends Error {
    public constructor(public readonly title: string) {
        super(`File "${title}" does not exist.`);
        this.name = 'FileNotFoundError';
    }
}

const assertFileExists = async (mwn: Mwn, title: string): Promise<void> => {
    const fileTitle = title.startsWith('File:') ? title : `File:${title}`;

    const response = await mwn.request({
        action: 'query',
        titles: fileTitle,
        prop: 'imageinfo',
        iiprop: 'timestamp',
        formatversion: '2',
    });

    const page = (response as { query?: { pages?: ApiPage[] } }).query?.pages?.[0];

    if (!page || page.missing || !page.imageinfo || page.imageinfo.length === 0) {
        throw new FileNotFoundError(title);
    }
};

export { FileNotFoundError, assertFileExists };
