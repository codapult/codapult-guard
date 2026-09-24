import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
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

export function finishGuardRun(
  root: string,
  context: GuardRunContext,
  outcome: GuardRunManifest['outcome'],
  gate: string,
  command = 'verify',
): GuardRunManifest {
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
  };
  try {
    writeGuardRun(root, manifest);
  } catch {
    // Verification must not fail because its local diagnostic record cannot be written.
  }
  return manifest;
}
