interface UploadDirs {
    list(): readonly string[];
}

class UploadDirsImpl implements UploadDirs {
    public constructor(private readonly dirs: readonly string[]) {}

    public list(): readonly string[] {
        return this.dirs;
    }
}

export { UploadDirsImpl };
export type { UploadDirs };
