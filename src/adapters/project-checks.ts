import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runProjectCommand, type CommandResult } from './command.js';

const require = createRequire(import.meta.url);
const { satisfies } = require('semver') as {
  satisfies: (version: string, range: string) => boolean;
};

export type ProjectCheck = 'lint' | 'typecheck' | 'test' | 'build';
export type GuardAdapter = 'dependency-graph' | 'security' | 'dependency-hygiene';
export type ExternalToolMode = 'auto' | 'on' | 'off';

export type ProjectCheckResults = Partial<Record<ProjectCheck, CommandResult>>;

interface PackageMetadata {
  engines?: { node?: string };
  packageManager?: string;
  scripts?: Record<string, string>;
}

export interface ProjectRuntimeDiagnostics {
  node: string;
  packageManager: string;
  declaredPackageManager?: string;
  declaredNode?: string;
  compatible: boolean;
  issues: string[];
}

function notConfigured(check: string): CommandResult {
  return {
    command: '',
    status: 'not-configured',
    passed: false,
    exitCode: 0,
    stdout: '',
    stderr: `${check} script is not configured`,
  };
}

function readPackageMetadata(root: string): PackageMetadata {
  try {
    return JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as PackageMetadata;
  } catch {
    return {};
  }
}

function packageManager(root: string, declared?: string): string {
  const name = declared?.split('@', 1)[0];
  if (name === 'pnpm' || name === 'yarn' || name === 'npm' || name === 'bun') return name;
  for (const [lockfile, manager] of [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['package-lock.json', 'npm'],
    ['bun.lockb', 'bun'],
    ['bun.lock', 'bun'],
  ] as const) {
    if (existsSync(resolve(root, lockfile))) return manager;
  }
  return 'pnpm';
}

export function inspectProjectRuntime(root: string): ProjectRuntimeDiagnostics {
  const metadata = readPackageMetadata(root);
  const manager = packageManager(root, metadata.packageManager);
  const issues: string[] = [];
  const declaredNode = metadata.engines?.node;
  let nodeCompatible = true;
  if (declaredNode) {
    try {
      nodeCompatible = satisfies(process.versions.node, declaredNode);
    } catch {
      nodeCompatible = false;
    }
  }
  if (declaredNode && !nodeCompatible) {
    issues.push(`Node ${process.versions.node} does not satisfy engines.node "${declaredNode}".`);
  }
  const declaredManager = metadata.packageManager?.split('@', 1)[0];
  if (declaredManager && declaredManager !== manager) {
    issues.push(
      `Detected package manager ${manager}, but packageManager declares ${declaredManager}.`,
    );
  }
  return {
    node: process.versions.node,
    packageManager: manager,
    ...(metadata.packageManager ? { declaredPackageManager: metadata.packageManager } : {}),
    ...(declaredNode ? { declaredNode } : {}),
    compatible: issues.length === 0,
    issues,
  };
}

function commandFor(
  root: string,
  manager: string,
  check: ProjectCheck,
  scripts: Record<string, string>,
): string | undefined {
  const run = (script: string, suffix = ''): string =>
    manager === 'npm' ? `npm run ${script}${suffix}` : `${manager} run ${script}${suffix}`;
  if (check === 'typecheck' && !scripts.typecheck && !scripts['type-check']) {
    if (!existsSync(resolve(root, 'tsconfig.json'))) return undefined;
    return manager === 'npm' ? 'npx --no-install tsc --noEmit' : `${manager} exec tsc --noEmit`;
  }
  if (check === 'typecheck') return run(scripts.typecheck ? 'typecheck' : 'type-check');
  if (!scripts[check]) return undefined;
  return run(check);
}

export function runProjectChecks(
  root: string,
  checks: ProjectCheck[],
  options: { timeout?: number } = {},
): ProjectCheckResults {
  const metadata = readPackageMetadata(root);
  const manager = packageManager(root, metadata.packageManager);
  const scripts = metadata.scripts ?? {};
  const results: Partial<Record<ProjectCheck, CommandResult>> = {};
  for (const check of checks) {
    const command = commandFor(root, manager, check, scripts);
    results[check] = command
      ? runProjectCommand(command, root, {
          timeout: options.timeout ?? (check === 'build' ? 300_000 : 120_000),
        })
      : notConfigured(check);
  }
  return results;
}

function hasCheck(scripts: Record<string, string>, check: ProjectCheck): boolean {
  return check === 'typecheck'
    ? Boolean(scripts.typecheck || scripts['type-check'])
    : Boolean(scripts[check]);
}

/**
 * Runs checks for workspace packages only when the root package does not own
 * the corresponding check. Root orchestration remains the source of truth.
 */
export function runWorkspaceProjectChecks(
  root: string,
  packages: { path: string; scripts: Record<string, string> }[],
  checks: ProjectCheck[],
  options: { timeout?: number; rootResults?: ProjectCheckResults } = {},
): Record<string, ProjectCheckResults> {
  const rootResults = options.rootResults ?? runProjectChecks(root, checks, options);
  const missingAtRoot = new Set(
    checks.filter((check) => rootResults[check]?.status === 'not-configured'),
  );
  return Object.fromEntries(
    packages
      .filter((workspace) =>
        checks.some((check) => missingAtRoot.has(check) && hasCheck(workspace.scripts, check)),
      )
      .map((workspace) => [
        workspace.path,
        runProjectChecks(resolve(root, workspace.path), [...missingAtRoot], options),
      ]),
  );
}

const adapterScriptPatterns: Record<GuardAdapter, RegExp> = {
  'dependency-graph': /(?:dep(?:endency)?[-:]?(?:check|graph|cruise)|madge|architecture)/i,
  security: /(?:security|semgrep|gitleaks|snyk|trivy|audit)/i,
  'dependency-hygiene': /(?:knip|dep(?:endency)?[-:]?(?:unused|hygiene))/i,
};

/** Runs only explicitly configured project scripts; Guard does not recreate these tools. */
export function runProjectAdapters(
  root: string,
  options: {
    mode?: Exclude<ExternalToolMode, 'off'>;
    timeout?: number;
    tooling?: Partial<Record<GuardAdapter, { script: string; enabled: boolean }>>;
  } = {},
): Partial<Record<GuardAdapter, CommandResult>> {
  const metadata = readPackageMetadata(root);
  const manager = packageManager(root, metadata.packageManager);
  const scripts = metadata.scripts ?? {};
  const results: Partial<Record<GuardAdapter, CommandResult>> = {};
  for (const [adapter, pattern] of Object.entries(adapterScriptPatterns) as [
    GuardAdapter,
    RegExp,
  ][]) {
    const configured = options.tooling?.[adapter];
    const script = configured?.enabled
      ? configured.script
      : configured?.enabled === false
        ? undefined
        : Object.keys(scripts).find((name) => pattern.test(name));
    if (!script && options.mode !== 'on') {
      continue;
    }
    if (!script) {
      results[adapter] = notConfigured(adapter);
      continue;
    }
    const command = manager === 'npm' ? `npm run ${script}` : `${manager} run ${script}`;
    results[adapter] = runProjectCommand(command, root, {
      timeout: options.timeout ?? 120_000,
    });
  }
  return results;
}
