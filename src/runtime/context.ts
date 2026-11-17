import type { Mwn } from 'mwn';
import type { LoginGate } from '../bwiki/loginGate.ts';
import type { EditSummarySettings } from '../config/editSummary.ts';
import type { ErrorClassifier } from '../errors/classifyError.ts';
import type { ResponseFormatter } from '../results/response.ts';
import type { EditService } from '../services/editService.ts';
import type { RevisionNormalizer } from '../services/revisionNormalize.ts';
import type { SectionService } from '../services/sectionService.ts';
import type { ActiveWiki } from '../wikis/activeWiki.ts';
import type { SiteInfoCache } from '../wikis/siteInfoCache.ts';
import type { UploadDirs } from '../wikis/uploadDirs.ts';
import type { WikiCache } from '../wikis/wikiCache.ts';
import type { WikiProbe } from '../wikis/wikiProbe.ts';
import type { WikiRegistry } from '../wikis/wikiRegistry.ts';
import type { Logger } from './logger.ts';

interface ToolContext {
    readonly mwn: (wikiKey?: string) => Promise<Mwn>;
    readonly wikis: WikiRegistry;
    readonly activeWiki: ActiveWiki;
    readonly uploadDirs: UploadDirs;
    readonly wikiCache: WikiCache;
    readonly siteInfoCache: SiteInfoCache;
    readonly wikiProbe: WikiProbe;
    readonly loginGate: LoginGate;
    readonly sections: SectionService;
    readonly edit: EditService;
    readonly revision: RevisionNormalizer;
    readonly format: ResponseFormatter;
    readonly errors: ErrorClassifier;
    readonly logger: Logger;
    readonly transport: 'http' | 'stdio';
    /** 编辑摘要生成设置；写工具经 formatEditComment 读取。 */
    readonly editSummary: EditSummarySettings;
}

interface ManagementContext extends ToolContext {
    readonly reconcile: () => Promise<void>;
}

export type { ToolContext, ManagementContext };
