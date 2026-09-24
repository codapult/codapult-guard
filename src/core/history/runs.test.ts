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
  GUARD_RUN_RETENTION,
  writeGuardRun,
  GuardRunManifestError,
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
  const parsedSequence = Number(runId.replace('guard-', ''));
  const sequence = Number.isFinite(parsedSequence) ? parsedSequence : 1;
  const startedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString();
  const completedAt = new Date(Date.parse(startedAt) + 1_000).toISOString();
  return {
    version: 1,
    runId,
    command: 'verify',
    startedAt,
    completedAt,
    durationMs: sequence * 10,
    outcome,
    gate: 'none',
    stages: {},
  };
}

describe('Guard run observability', () => {
  it('lists recent manifests and summarizes outcomes', () => {
    const root = createRoot();
    writeGuardRun(root, manifest('guard-1', 'pass'));
    writeGuardRun(root, manifest('guard-2', 'fail'));
    writeGuardRun(root, manifest('guard-3', 'warning'));

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
    writeGuardRun(root, manifest('guard-1', 'pass'));
    const path = join(root, GUARD_RUNS_DIR, 'broken.json');
    mkdirSync(join(root, GUARD_RUNS_DIR), { recursive: true });
    writeFileSync(path, '{not-json', 'utf8');
    expect(existsSync(path)).toBe(true);

    expect(listGuardRuns(root)).toHaveLength(1);
  });

  it('ignores JSON that is not a valid Guard run manifest', () => {
    const root = createRoot();
    const directory = join(root, GUARD_RUNS_DIR);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'spoofed.json'),
      JSON.stringify({ version: 1, outcome: 'pass', gate: 'none' }),
      'utf8',
    );

    expect(listGuardRuns(root)).toEqual([]);
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

  it('bounds persisted run history', () => {
    const root = createRoot();
    for (let index = 0; index <= GUARD_RUN_RETENTION; index += 1) {
      writeGuardRun(root, manifest(`guard-${index + 1}`, 'pass'));
    }

    expect(listGuardRuns(root, GUARD_RUN_RETENTION + 1)).toHaveLength(GUARD_RUN_RETENTION);
  });

  it('rejects a run ID that could escape the run directory', () => {
    const root = createRoot();
    const unsafe = manifest('../escaped', 'pass');

    expect(() => writeGuardRun(root, unsafe)).toThrow(GuardRunManifestError);
    expect(existsSync(join(root, '.codapult/guard/escaped.json'))).toBe(false);
  });
});
