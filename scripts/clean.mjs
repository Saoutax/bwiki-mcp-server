/** Remove the build output.
 *
 * The compiler does not remove outputs for sources that were deleted or
 * renamed, so a reproducible build starts from an empty dist/.
 */

import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

rmSync(join(root, 'dist'), { recursive: true, force: true });
console.log('removed dist/');
