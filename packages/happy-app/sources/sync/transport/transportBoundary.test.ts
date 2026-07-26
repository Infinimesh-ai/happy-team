import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Boundary guard (Phase 1 Wave C): the apiSocket singleton may only be
 * consumed inside sync/transport/. Everything else goes through the
 * HappyTransport facade. The helper exports getHappyClientId /
 * getCurrentAppState remain importable from anywhere — they are plain
 * config helpers, not network access.
 */

const SOURCES_ROOT = join(__dirname, '..', '..');
const ALLOWED_DIRS = ['sync/transport'];
const ALLOWED_FILES = ['sync/apiSocket.ts'];

function collectSourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            if (entry === 'node_modules' || entry === 'trash') continue;
            collectSourceFiles(full, out);
        } else if (/\.(ts|tsx)$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) {
            out.push(full);
        }
    }
    return out;
}

describe('transport boundary', () => {
    it('bans importing the apiSocket singleton outside sync/transport/', () => {
        const offenders: string[] = [];
        for (const file of collectSourceFiles(SOURCES_ROOT)) {
            const rel = relative(SOURCES_ROOT, file).replace(/\\/g, '/');
            if (ALLOWED_FILES.includes(rel) || ALLOWED_DIRS.some((d) => rel.startsWith(`${d}/`))) {
                continue;
            }
            const content = readFileSync(file, 'utf8');
            // Match importing the `apiSocket` binding specifically.
            if (/import\s+(type\s+)?{[^}]*\bapiSocket\b[^}]*}\s+from/.test(content)) {
                offenders.push(rel);
            }
        }
        expect(offenders).toEqual([]);
    });
});
