import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config.js';

export const GUARD_RUNS_DIR = `.${config.appName}/guard/history/runs`;

export interface GuardRunStage {
  durationMs: number;
  status: 'ok' | 'fail' | 'skipped';
  detail?: string | undefined;
}

export interface GuardRunManifest {
  version: 1;
  runId: string;
  command: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  outcome: 'pass' | 'fail' | 'warning' | 'needs-review' | 'not-configured';
  gate: string;
  stages: Record<string, GuardRunStage>;
  commit?: string | undefined;
}

export interface GuardRunContext {
  runId: string;
  startedAt: string;
  startedAtMs: number;
  stages: Record<string, GuardRunStage>;
}

export interface GuardRunSummary {
  total: number;
  passed: number;
  failed: number;
  warnings: number;
  averageDurationMs: number;
  last?: GuardRunManifest | undefined;
}

export function startGuardRun(): GuardRunContext {
  return {
    runId: `guard-${randomUUID()}`,
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
    stages: {},
  };
}

export function recordGuardRunStage(
  context: GuardRunContext,
  name: string,
  status: GuardRunStage['status'],
  startedAtMs: number,
  detail?: string,
): void {
  context.stages[name] = {
    durationMs: Math.max(0, Date.now() - startedAtMs),
    status,
    ...(detail ? { detail } : {}),
  };
}

export function writeGuardRun(root: string, manifest: GuardRunManifest): void {
  const directory = resolve(root, GUARD_RUNS_DIR);
  mkdirSync(directory, { recursive: true });
  const path = resolve(directory, `${manifest.runId}.json`);
  const temporaryPath = `${path}.tmp-${process.pid}-${manifest.runId}`;
  writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  renameSync(temporaryPath, path);
}

/** Reads locally persisted run manifests without reaching a remote service. */
export function listGuardRuns(root: string, limit = 20): GuardRunManifest[] {
  if (!Number.isInteger(limit) || limit < 1) return [];
  const directory = resolve(root, GUARD_RUNS_DIR);
  try {
    return readdirSync(directory)
      .filter((file) => file.endsWith('.json'))
      .map((file) => {
        try {
          return JSON.parse(readFileSync(resolve(directory, file), 'utf8')) as GuardRunManifest;
        } catch {
          return undefined;
        }
      })
      .filter((manifest): manifest is GuardRunManifest => manifest !== undefined)
      .sort((left, right) => right.completedAt.localeCompare(left.completedAt))
      .slice(0, limit);
  } catch {
    return [];
  }
}

export function summarizeGuardRuns(root: string, limit = 100): GuardRunSummary {
  const runs = listGuardRuns(root, limit);
  const total = runs.length;
  return {
    total,
    passed: runs.filter((run) => run.outcome === 'pass').length,
    failed: runs.filter((run) => run.outcome === 'fail').length,
    warnings: runs.filter((run) => run.outcome === 'warning').length,
    averageDurationMs:
      total === 0 ? 0 : Math.round(runs.reduce((sum, run) => sum + run.durationMs, 0) / total),
    ...(total > 0 ? { last: runs[0] } : {}),
  };
}

export function finishGuardRun(
  root: string,
  context: GuardRunContext,
  outcome: GuardRunManifest['outcome'],
  gate: string,
  command = 'verify',
): GuardRunManifest {
  let commit: string | undefined;
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, stdio: 'pipe' })
      .toString()
      .trim();
  } catch {
    commit = undefined;
  }
  const manifest: GuardRunManifest = {
    version: 1,
    runId: context.runId,
    command,
    startedAt: context.startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Math.max(0, Date.now() - context.startedAtMs),
    outcome,
    gate,
    stages: context.stages,
    ...(commit ? { commit } : {}),
  };
  try {
    writeGuardRun(root, manifest);
  } catch {
    // Verification must not fail because its local diagnostic record cannot be written.
  }
  return manifest;
}
