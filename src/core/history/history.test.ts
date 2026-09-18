import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GUARD_HISTORY_DIR } from '../guard.js';
import { diffGuardSnapshots, listGuardSnapshots } from './history.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function model(
  files: string[],
  dependencies: Record<string, string>,
  capabilities: string[],
): {
  version: 1;
  files: { path: string; kind: string; bytes: number }[];
  modules: never[];
  project: { dependencies: Record<string, string>; devDependencies: Record<string, string> };
  capabilities: Record<string, object>;
  insights: { cycles: never[] };
} {
  return {
    version: 1,
    files: files.map((path) => ({ path, kind: 'source', bytes: 1 })),
    modules: [],
    project: { dependencies, devDependencies: {} },
    capabilities: Object.fromEntries(capabilities.map((name) => [name, {}])),
    insights: { cycles: [] },
  };
}

describe('Guard history', () => {
  it('lists snapshots and compares project changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'guard-history-'));
    roots.push(root);
    mkdirSync(join(root, GUARD_HISTORY_DIR), { recursive: true });
    writeFileSync(
      join(root, GUARD_HISTORY_DIR, 'a.json'),
      JSON.stringify(model(['a.ts'], { react: '1' }, ['ui'])),
    );
    writeFileSync(
      join(root, GUARD_HISTORY_DIR, 'b.json'),
      JSON.stringify(model(['b.ts'], { next: '1' }, ['api'])),
    );

    expect(listGuardSnapshots(root)).toHaveLength(2);
    expect(diffGuardSnapshots(root, 'a', 'b')).toMatchObject({
      addedFiles: ['b.ts'],
      removedFiles: ['a.ts'],
      addedDependencies: ['next'],
      removedDependencies: ['react'],
      addedCapabilities: ['api'],
      removedCapabilities: ['ui'],
    });
  });
});
