import { LoginGateImpl, type LoginGate } from '../bwiki/loginGate.ts';
import type { EditSummarySettings } from '../config/editSummary.ts';
import type { Config } from '../config/loadConfig.ts';
import { DEFAULT_SESSION_FILE } from '../config/loadConfig.ts';
import { getRuntimeToken } from '../runtime/requestContext.ts';
import { ActiveWikiImpl, type ActiveWiki } from './activeWiki.ts';
import { MwnProviderImpl, type MwnProvider } from './mwnProvider.ts';
import { SiteInfoCacheImpl, type SiteInfoCache } from './siteInfoCache.ts';
import { UploadDirsImpl, type UploadDirs } from './uploadDirs.ts';
import { WikiProbeImpl, type WikiProbe } from './wikiProbe.ts';
import { WikiRegistryImpl, type WikiRegistry } from './wikiRegistry.ts';

interface AppState {
    readonly wikiRegistry: WikiRegistry;
    readonly activeWiki: ActiveWiki;
    readonly uploadDirs: UploadDirs;
    readonly mwnProvider: MwnProvider;
    readonly siteInfoCache: SiteInfoCache;
    readonly wikiProbe: WikiProbe;
    readonly loginGate: LoginGate;
    readonly editSummary: EditSummarySettings;
    readonly editTags: readonly string[];
    readonly moderationAwareness: boolean;
}

const createAppState = (config: Config): AppState => {
    const wikiRegistry = new WikiRegistryImpl(config.wikis, config.allowWikiManagement !== false);
    const activeWiki = new ActiveWikiImpl(config.defaultWiki, wikiRegistry);
    const uploadDirs = new UploadDirsImpl(config.uploadDirs);
    const mwnProvider = new MwnProviderImpl(wikiRegistry, activeWiki, getRuntimeToken);
    const siteInfoCache = new SiteInfoCacheImpl();
    const wikiProbe = new WikiProbeImpl(wikiRegistry);
    const loginGate = new LoginGateImpl(DEFAULT_SESSION_FILE, mwnProvider);
    return {
        wikiRegistry,
        activeWiki,
        uploadDirs,
        mwnProvider,
        siteInfoCache,
        wikiProbe,
        loginGate,
        editSummary: config.editSummary,
        editTags: config.editTags,
        moderationAwareness: config.moderationAwareness,
    };
};

export { createAppState };
export type { AppState };
