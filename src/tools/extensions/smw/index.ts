import type { ExtensionPack } from '../types.ts';
import { smwListProperties } from './smw-list-properties.ts';
import { smwQuery } from './smw-query.ts';

const smwPack: ExtensionPack = {
    id: 'smw',
    extensionNames: ['SemanticMediaWiki'],
    tools: [smwQuery, smwListProperties],
};

export { smwPack };
