// Builds the download-and-double-click app: the CLI bundled into one file,
// injected into a copy of a node binary (Node single executable applications).
//
//   node scripts/sea.mjs <output file> [node binary]
//
// The node binary defaults to the one running this script and has to be the
// same version. CI passes a darwin-x64 node on the arm64 runner to get both Macs.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';
import { inject } from 'postject';

const [out, nodeBinary = process.execPath] = process.argv.slice(2);
if (!out) throw new Error('usage: node scripts/sea.mjs <output file> [node binary]');

const work = join('build', 'sea');
mkdirSync(work, { recursive: true });
mkdirSync(dirname(out), { recursive: true });

const main = join(work, 'svietlik.cjs');
await build({
  entryPoints: ['cli/svietlik.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: main,
  logLevel: 'warning',
});
// the entry's shebang is not valid inside the injected script
writeFileSync(main, readFileSync(main, 'utf8').replace(/^#!.*\n/, ''));

const blob = join(work, 'svietlik.blob');
const config = join(work, 'sea-config.json');
writeFileSync(config, JSON.stringify({ main, output: blob, disableExperimentalSEAWarning: true }));
execFileSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'inherit' });

copyFileSync(nodeBinary, out);
const mac = process.platform === 'darwin';
if (mac) execFileSync('codesign', ['--remove-signature', out]);
await inject(out, 'NODE_SEA_BLOB', readFileSync(blob), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  machoSegmentName: mac ? 'NODE_SEA' : undefined,
});
// Apple silicon refuses to run an unsigned binary at all, an ad hoc signature is enough
if (mac) execFileSync('codesign', ['--sign', '-', out]);
console.log(`built ${out}`);
