/**
 * Regenerate the cross-implementation conformance vectors in test/vectors/
 * from the pinned ISCP Go reference implementation.
 *
 * The upstream repository ships its conformance suite as a Go test package,
 * not as portable JSON vectors, so this package generates its own: the Go
 * program in conformance-gen/ imports the upstream module at the pinned
 * commit (scripts/pin.json) and emits deterministic fixtures that the vitest
 * suite replays against the TypeScript implementation.
 *
 * Requires a Go toolchain. The generated vectors are committed, so tests and
 * CI never need Go — run this only when bumping the pin.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pin = JSON.parse(readFileSync(join(packageRoot, 'scripts', 'pin.json'), 'utf8')) as {
  repository: string;
  commit: string;
};

const genDir = join(packageRoot, 'conformance-gen');

// Verify the generator's go.mod resolves to the pinned commit before trusting its output.
const moduleInfo = JSON.parse(
  execFileSync('go', ['list', '-m', '-json', 'github.com/Infinimesh-ai/ISCP'], { cwd: genDir, encoding: 'utf8' }),
) as { Version: string; Origin?: { Hash?: string } };

const resolvedHash = moduleInfo.Origin?.Hash;
if (resolvedHash !== undefined && resolvedHash !== pin.commit) {
  console.error(`conformance-gen resolves ${moduleInfo.Version} (${resolvedHash}), but scripts/pin.json pins ${pin.commit}.`);
  console.error('Update conformance-gen/go.mod (go get github.com/Infinimesh-ai/ISCP@<sha>) or pin.json first.');
  process.exit(1);
}
if (resolvedHash === undefined) {
  console.warn(`warning: module cache does not record an origin hash for ${moduleInfo.Version}; trusting go.sum.`);
}

console.log(`Generating vectors from ${pin.repository}@${pin.commit} (${moduleInfo.Version})...`);
execFileSync('go', ['run', '.', '-out', join(packageRoot, 'test', 'vectors'), '-pin', pin.commit], {
  cwd: genDir,
  stdio: 'inherit',
});
console.log('Done. Review the diff and re-run `pnpm test`.');
