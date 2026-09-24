import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  finishGuardRun,
  listGuardRuns,
  startGuardRun,
  summarizeGuardRuns,
  GUARD_RUNS_DIR,
  writeGuardRun,
  type GuardRunManifest,
} from './runs.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'codapult-guard-runs-'));
  roots.push(root);
  return root;
}

function manifest(runId: string, outcome: GuardRunManifest['outcome']): GuardRunManifest {
  return {
    version: 1,
    runId,
    command: 'verify',
    startedAt: `2026-01-01T00:00:0${runId}Z`,
    completedAt: `2026-01-01T00:00:1${runId}Z`,
    durationMs: Number(runId) * 10,
    outcome,
    gate: 'none',
    stages: {},
  };
}

describe('Guard run observability', () => {
  it('lists recent manifests and summarizes outcomes', () => {
    const root = createRoot();
    writeGuardRun(root, manifest('1', 'pass'));
    writeGuardRun(root, manifest('2', 'fail'));
    writeGuardRun(root, manifest('3', 'warning'));

    expect(listGuardRuns(root, 2)).toHaveLength(2);
    expect(summarizeGuardRuns(root)).toMatchObject({
      total: 3,
      passed: 1,
      failed: 1,
      warnings: 1,
      averageDurationMs: 20,
    });
  });

  it('ignores malformed local manifests', () => {
    const root = createRoot();
    writeGuardRun(root, manifest('1', 'pass'));
    const path = join(root, GUARD_RUNS_DIR, 'broken.json');
    mkdirSync(join(root, GUARD_RUNS_DIR), { recursive: true });
    writeFileSync(path, '{not-json', 'utf8');
    expect(existsSync(path)).toBe(true);

    expect(listGuardRuns(root)).toHaveLength(1);
  });

  it('creates a completed manifest with stage timings', () => {
    const root = createRoot();
    const context = startGuardRun();
    context.stages.discovery = { durationMs: 4, status: 'ok' };

    const result = finishGuardRun(root, context, 'pass', 'none');

    expect(result).toMatchObject({
      outcome: 'pass',
      gate: 'none',
      stages: { discovery: { status: 'ok' } },
    });
    expect(listGuardRuns(root)).toHaveLength(1);
  });
});
