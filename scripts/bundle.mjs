/** Bundle the server into one file.
 *
 * The MCP entry point is expected to be a single file the client can point at,
 * and a checkout with node_modules/ is not that. esbuild inlines the whole
 * module graph, including the CommonJS dependencies (mwn, axios), into one CommonJS
 * file with a node shebang.
 *
 * The package version is injected as a define so the running server reports the
 * version it was built from. Without it the fallback in constants.ts goes stale
 * every release.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const result = await build({
    // 相对路径一律以仓库根为基准，避免从其他目录调用时解析错位。
    absWorkingDir: root,
    entryPoints: ['src/stdio.ts'],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    outfile: 'dist/bundle.cjs',
    // 全部内联：发布的单文件要能脱离 node_modules 直接运行。
    define: {
        'process.env.BWIKI_MCP_VERSION': JSON.stringify(version),
    },
    logLevel: 'info',
});

if (result.errors.length > 0) {
    process.exit(1);
}
console.log(`bundled -> dist/bundle.cjs (version ${version})`);
