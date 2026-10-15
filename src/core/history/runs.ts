import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config.js';
import { withGuardStateLock } from '../guard.js';

export const GUARD_RUNS_DIR = `.${config.appName}/guard/history/runs`;
export const GUARD_RUN_RETENTION = 200;

export interface GuardRunStage {
  durationMs: number;
  status: 'ok' | 'fail' | 'skipped';
  detail?: string | undefined;
}

export interface GuardRunPolicy {
  revision?: number | undefined;
  fingerprint: string;
  source: 'working-tree' | 'git-ref';
  ref?: string | undefined;
  changedFromBase?: boolean | undefined;
  decisionIds?: string[] | undefined;
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
  policy?: GuardRunPolicy | undefined;
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

export class GuardRunManifestError extends Error {
  constructor() {
    super('Guard run manifest is invalid or contains an unsafe run ID.');
    this.name = 'GuardRunManifestError';
  }
}

function isGuardRunManifest(value: unknown): value is GuardRunManifest {
  if (value === null || typeof value !== 'object') return false;
  const manifest = value as Partial<GuardRunManifest>;
  const stages = manifest.stages;
  const validStages =
    stages !== null &&
    typeof stages === 'object' &&
    !Array.isArray(stages) &&
    Object.values(stages).every((stage) => {
      if (stage === null || typeof stage !== 'object') return false;
      const candidate = stage as Partial<GuardRunStage>;
      return (
        typeof candidate.durationMs === 'number' &&
        Number.isFinite(candidate.durationMs) &&
        candidate.durationMs >= 0 &&
        (candidate.status === 'ok' ||
          candidate.status === 'fail' ||
          candidate.status === 'skipped') &&
        (candidate.detail === undefined || typeof candidate.detail === 'string')
      );
    });
  return (
    manifest.version === 1 &&
    typeof manifest.runId === 'string' &&
    /^guard-[A-Za-z0-9-]+$/.test(manifest.runId) &&
    typeof manifest.command === 'string' &&
    typeof manifest.startedAt === 'string' &&
    Number.isFinite(Date.parse(manifest.startedAt)) &&
    typeof manifest.completedAt === 'string' &&
    Number.isFinite(Date.parse(manifest.completedAt)) &&
    Date.parse(manifest.completedAt) >= Date.parse(manifest.startedAt) &&
    typeof manifest.durationMs === 'number' &&
    Number.isFinite(manifest.durationMs) &&
    manifest.durationMs >= 0 &&
    (manifest.outcome === 'pass' ||
      manifest.outcome === 'fail' ||
      manifest.outcome === 'warning' ||
      manifest.outcome === 'needs-review' ||
      manifest.outcome === 'not-configured') &&
    typeof manifest.gate === 'string' &&
    validStages &&
    (manifest.policy === undefined ||
      (manifest.policy !== null &&
        typeof manifest.policy === 'object' &&
        typeof manifest.policy.fingerprint === 'string' &&
        manifest.policy.fingerprint.length > 0 &&
        (manifest.policy.source === 'working-tree' || manifest.policy.source === 'git-ref') &&
        (manifest.policy.revision === undefined ||
          (Number.isInteger(manifest.policy.revision) && manifest.policy.revision >= 0)) &&
        (manifest.policy.ref === undefined || typeof manifest.policy.ref === 'string') &&
        (manifest.policy.changedFromBase === undefined ||
          typeof manifest.policy.changedFromBase === 'boolean') &&
        (manifest.policy.decisionIds === undefined ||
          (manifest.policy.source === 'working-tree' &&
            Array.isArray(manifest.policy.decisionIds) &&
            new Set(manifest.policy.decisionIds).size === manifest.policy.decisionIds.length &&
            manifest.policy.decisionIds.every(
              (decisionId) => typeof decisionId === 'string' && decisionId.trim().length > 0,
            )))))
  );
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

function pruneGuardRuns(root: string): void {
  const directory = resolve(root, GUARD_RUNS_DIR);
  try {
    if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) return;
    const files = readdirSync(directory)
      .filter((file) => file.endsWith('.json'))
      .map((file) => ({
        file,
        modifiedAt: lstatSync(resolve(directory, file)).isSymbolicLink()
          ? 0
          : statSync(resolve(directory, file)).mtimeMs,
      }))
      .sort((left, right) => right.modifiedAt - left.modifiedAt);
    for (const entry of files.slice(GUARD_RUN_RETENTION)) {
      try {
        unlinkSync(resolve(directory, entry.file));
      } catch {
        // Retention is best effort; a concurrent reader may own the file.
      }
    }
  } catch {
    // Diagnostics must never fail because retention cannot be completed.
  }
}

export function writeGuardRun(root: string, manifest: GuardRunManifest): void {
  if (!isGuardRunManifest(manifest)) throw new GuardRunManifestError();
  withGuardStateLock(root, () => {
    const directory = resolve(root, GUARD_RUNS_DIR);
    if (existsSync(directory)) {
      const stats = lstatSync(directory);
      if (stats.isSymbolicLink() || !stats.isDirectory()) throw new GuardRunManifestError();
    }
    mkdirSync(directory, { recursive: true });
    const path = resolve(directory, `${manifest.runId}.json`);
    const temporaryPath = `${path}.tmp-${process.pid}-${manifest.runId}`;
    writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    renameSync(temporaryPath, path);
    pruneGuardRuns(root);
  });
}

/** Reads locally persisted run manifests without reaching a remote service. */
export function listGuardRuns(root: string, limit = 20): GuardRunManifest[] {
  if (!Number.isInteger(limit) || limit < 1) return [];
  const boundedLimit = Math.min(limit, 1_000);
  const directory = resolve(root, GUARD_RUNS_DIR);
  try {
    const directoryStats = lstatSync(directory);
    if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) return [];
    return readdirSync(directory)
      .filter((file) => file.endsWith('.json'))
      .filter((file) => {
        try {
          return lstatSync(resolve(directory, file)).isFile();
        } catch {
          return false;
        }
      })
      .map((file) => {
        try {
          const value: unknown = JSON.parse(readFileSync(resolve(directory, file), 'utf8'));
          return isGuardRunManifest(value) ? value : undefined;
        } catch {
          return undefined;
        }
      })
      .filter((manifest): manifest is GuardRunManifest => manifest !== undefined)
      .sort((left, right) => right.completedAt.localeCompare(left.completedAt))
      .slice(0, boundedLimit);
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
  policy?: GuardRunPolicy,
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
    ...(policy ? { policy } : {}),
  };
  try {
    writeGuardRun(root, manifest);
  } catch {
    // Verification must not fail because its local diagnostic record cannot be written.
  }
  return manifest;
}
