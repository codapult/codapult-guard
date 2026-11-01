import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, relative, resolve, sep } from 'node:path';
import { type CommandResult } from '../../adapters/command.js';
import type { ProjectCheck } from '../model/types.js';
import {
  runProjectAdapters,
  runProjectChecks,
  runWorkspaceProjectChecks,
  inspectProjectRuntime,
  type GuardAdapter,
  type ProjectCheckResults,
  type ProjectRuntimeDiagnostics,
} from '../../adapters/project-checks.js';
import {
  GUARD_DIR,
  GUARD_HISTORY_DIR,
  loadGuardPolicyAtRevision,
  loadGuardWorkingTreePolicy,
  scanGuard,
  classifyGuardOutcome,
  validateGuardPolicy,
  type GuardToolMode,
  type GuardContractIssue,
  type GuardReport,
  type GuardPolicySnapshot,
  type GuardPolicySurfacePolicy,
} from '../guard.js';
import { analyzeProjectImpact, type GuardImpactAnalysis } from '../analysis/impact.js';
import { discoverProject } from '../discovery/discovery.js';
import {
  finishGuardRun,
  recordGuardRunStage,
  startGuardRun,
  type GuardRunManifest,
  type GuardRunPolicy,
  type GuardVerificationReceipt,
  type GuardVerificationReceiptCheck,
  type GuardVerificationReceiptPolicySurface,
  type GuardVerificationScope,
  type GuardVerificationCiIntegrity,
} from '../history/runs.js';
import { auditGitHubActions } from './github-actions.js';
import { readGuardGitHubContext } from './github-context.js';

const require = createRequire(import.meta.url);
const packageJson = require('../../../package.json') as { version: string };

export type GuardVerificationCheck = ProjectCheck;

export interface GuardVerificationOptions {
  checks?: GuardVerificationCheck[] | undefined;
  changedOnly?: boolean | undefined;
  timeout?: number | undefined;
  requirement?: string | undefined;
  tools?: GuardToolMode | undefined;
  strict?: boolean | undefined;
  projectChecks?: boolean | undefined;
  policyBase?: string | undefined;
  failOnPolicyChange?: boolean | undefined;
  failOnProtectedChanges?: boolean | undefined;
}

export interface GuardVerificationResult {
  status: 'ok' | 'fail' | 'incomplete' | 'policy-weakened' | 'not-configured';
  outcome:
    | 'pass'
    | 'fail'
    | 'incomplete'
    | 'policy-weakened'
    | 'warning'
    | 'needs-review'
    | 'not-configured';
  errorCode?:
    | 'GUARD_NOT_CONFIGURED'
    | 'GUARD_CONFIG_INVALID'
    | 'GUARD_POLICY_BASE_INVALID'
    | 'GUARD_POLICY_CHANGED'
    | 'GUARD_PROTECTED_PATH_CHANGED'
    | 'GUARD_CI_POLICY_WEAKENED'
    | 'GUARD_CI_POLICY_INCOMPLETE'
    | 'GUARD_REQUIRED_STAGE_INCOMPLETE'
    | 'GUARD_POLICY_SURFACE_INCOMPLETE'
    | undefined;
  recoverable?: boolean | undefined;
  tools?: GuardToolMode | undefined;
  checks: ProjectCheckResults;
  workspaceChecks: Record<string, ProjectCheckResults>;
  adapters: Partial<Record<GuardAdapter, CommandResult>>;
  runtime: ProjectRuntimeDiagnostics;
  configError?: string | undefined;
  architecture?: GuardReport | undefined;
  impact?: GuardImpactAnalysis | undefined;
  contractIssues: GuardContractIssue[];
  requirement: {
    status: 'delegated-to-review';
    provided: boolean;
    message: string;
  };
  run: GuardRunManifest;
  policy?: GuardRunPolicy | undefined;
  policyChanged?: boolean | undefined;
  policySurface?: GuardPolicySurface | undefined;
  ciIntegrity?: GuardVerificationCiIntegrity | undefined;
  requiredStages?: string[] | undefined;
  incompleteStages?: string[] | undefined;
}

const DEFAULT_PROTECTED_PATHS = [
  '.codapult/guard/**',
  '.github/workflows/**',
  'CODEOWNERS',
  '.github/CODEOWNERS',
  'package.json',
  '**/package.json',
  'pnpm-lock.yaml',
  '**/pnpm-lock.yaml',
  'yarn.lock',
  '**/yarn.lock',
  'package-lock.json',
  '**/package-lock.json',
  'npm-shrinkwrap.json',
  '**/npm-shrinkwrap.json',
  'bun.lock',
  '**/bun.lock',
  'bun.lockb',
  '**/bun.lockb',
  'pnpm-workspace.yaml',
  '**/pnpm-workspace.yaml',
  '.npmrc',
  '**/.npmrc',
  '.pnpmfile.cjs',
  '**/.pnpmfile.cjs',
  'pnpmfile.cjs',
  '**/pnpmfile.cjs',
  '.yarnrc',
  '**/.yarnrc',
  '.yarnrc.yml',
  '**/.yarnrc.yml',
  '.pnp.cjs',
  '**/.pnp.cjs',
  '.pnp.loader.mjs',
  '**/.pnp.loader.mjs',
  '.gitignore',
  '.ignore',
  '.dockerignore',
  '.npmignore',
  '.prettierignore',
  '.eslintignore',
  'eslint.config.*',
  '.eslintrc*',
  'biome.json',
  'biome.jsonc',
  '.biomeignore',
  'prettier.config.*',
  '.prettierrc*',
  'tsconfig.json',
  'vitest.config.*',
  'jest.config.*',
  'playwright.config.*',
  'next.config.*',
  'babel.config.*',
  '.babelrc*',
  'webpack.config.*',
  'stylelint.config.*',
  '.stylelintrc*',
  'nyc.config.*',
  'tsconfig*.json',
];

function matchesPathPattern(path: string, pattern: string): boolean {
  let expression = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
        expression += '(?:.*/)?';
        index += 2;
      } else {
        expression += '.*';
        index += 1;
      }
    } else if (character === '*') expression += '[^/]*';
    else if (character === '?') expression += '[^/]';
    else expression += '.+^${}()|[]\\'.includes(character) ? `\\${character}` : character;
  }
  return new RegExp(`${expression}$`).test(path);
}

const SOURCE_EXTENSIONS = new Set([
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.mjs',
  '.cjs',
  '.html',
  '.md',
  '.mdx',
  '.py',
  '.pyi',
  '.sh',
  '.vue',
  '.svelte',
]);
const SUPPRESSION_COMMENT =
  /(?:\/\/|\/\*|\*|<!--|#)\s*(eslint-disable|@ts-ignore|@ts-nocheck|@ts-expect-error|biome-ignore|prettier-ignore|tslint:disable|stylelint-disable|standard:disable|svelte-ignore|noqa|nosec|type:\s*ignore|pragma:\s*no\s+cover|istanbul\s+ignore|c8\s+ignore)\b/i;

function addedSuppressionMarkers(root: string, baseRef: string | undefined): string[] | undefined {
  if (!baseRef) return undefined;
  try {
    const diffs = [
      execFileSync('git', ['diff', '--no-ext-diff', '--unified=0', `${baseRef}...HEAD`], {
        cwd: root,
        stdio: 'pipe',
        timeout: 5_000,
        maxBuffer: 8_000_000,
      }).toString(),
      execFileSync('git', ['diff', '--no-ext-diff', '--unified=0', 'HEAD'], {
        cwd: root,
        stdio: 'pipe',
        timeout: 5_000,
        maxBuffer: 8_000_000,
      }).toString(),
    ];
    const found = new Set<string>();
    for (const diff of diffs) {
      let file = '';
      for (const line of diff.split('\n')) {
        if (line.startsWith('+++ "')) return undefined;
        if (line.startsWith('+++ b/')) file = line.slice(6);
        else if (line.startsWith('+') && !line.startsWith('+++')) {
          const extension = extname(file).toLowerCase();
          const match = SUPPRESSION_COMMENT.exec(line);
          if (file && SOURCE_EXTENSIONS.has(extension) && match?.[1]) {
            found.add(`${file}:${match[1].toLowerCase()}`);
          }
        }
      }
    }

    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
      cwd: root,
      stdio: 'pipe',
      timeout: 5_000,
      maxBuffer: 8_000_000,
    })
      .toString()
      .split('\0')
      .filter(Boolean);
    const realRoot = realpathSync(root);
    for (const file of untracked) {
      if (!SOURCE_EXTENSIONS.has(extname(file).toLowerCase())) continue;
      const absolutePath = resolve(root, file);
      const realFilePath = realpathSync(absolutePath);
      const fileRelative = relative(realRoot, realFilePath);
      if (fileRelative === '..' || fileRelative.startsWith(`..${sep}`)) return undefined;
      const stats = lstatSync(absolutePath);
      if (stats.isSymbolicLink() || !stats.isFile() || stats.size > 2_000_000) return undefined;
      const source = readFileSync(absolutePath, 'utf8');
      if (source.includes('\0')) continue;
      for (const line of source.split('\n')) {
        const match = SUPPRESSION_COMMENT.exec(line);
        if (match?.[1]) found.add(`${file}:${match[1].toLowerCase()}`);
      }
    }
    return [...found].sort();
  } catch {
    return undefined;
  }
}

function isGeneratedGuardArtifact(path: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  return (
    normalized === `${GUARD_DIR}/.state.lock` ||
    normalized === `${GUARD_DIR}/cache.json` ||
    normalized === GUARD_HISTORY_DIR ||
    normalized.startsWith(`${GUARD_HISTORY_DIR}/`)
  );
}

function gitPaths(root: string, commands: string[][]): string[] | undefined {
  try {
    const pathLists = commands.map((args) =>
      execFileSync('git', args, {
        cwd: root,
        stdio: 'pipe',
        timeout: 5_000,
      }).toString(),
    );
    return [...new Set(pathLists.flatMap((paths) => paths.split('\0')))]
      .map((file) => file.replace(/\\/g, '/'))
      .filter((file) => Boolean(file) && !isGeneratedGuardArtifact(file))
      .sort();
  } catch {
    return undefined;
  }
}

function committedFilesSince(root: string, baseRef: string | undefined): string[] | undefined {
  if (!baseRef) return undefined;
  return gitPaths(root, [['diff', '--name-only', '-z', `${baseRef}...HEAD`]]);
}

function workingTreeChangedFiles(root: string): string[] | undefined {
  return gitPaths(root, [
    ['diff', '--name-only', '-z', 'HEAD'],
    ['ls-files', '--others', '--exclude-standard', '-z'],
  ]);
}

function changedFilesSince(root: string, baseRef: string | undefined): string[] | undefined {
  if (!baseRef) return undefined;
  const committed = committedFilesSince(root, baseRef);
  const workingTree = workingTreeChangedFiles(root);
  if (!committed || !workingTree) return undefined;
  return [...new Set([...committed, ...workingTree])].sort();
}

interface GuardPolicySurface {
  protectedPaths: string[];
  changedPaths: string[];
  changes: { path: string; pattern: string; kind: string; severity: 'warning' | 'error' }[];
  suppressionMarkers: string[];
  workflowChanged: boolean;
  complete: boolean;
}

function getPolicySurface(
  root: string,
  baseRef: string | undefined,
  configPaths: string[] = [],
  policySurfaceConfig?: GuardPolicySurfacePolicy,
): GuardPolicySurface {
  const baseChangedPaths = changedFilesSince(root, baseRef);
  const changedPaths = baseChangedPaths ?? [];
  const suppressionMarkers = addedSuppressionMarkers(root, baseRef);
  const defaultEntries = DEFAULT_PROTECTED_PATHS.map((pattern) => ({
    pattern,
    kind: pattern.startsWith('.github/workflows/')
      ? 'ci-workflow'
      : pattern.startsWith('.codapult/guard/')
        ? 'guard-policy'
        : pattern.toLowerCase().includes('codeowners')
          ? 'ownership'
          : ['package.json', 'lock.yaml', 'lock.json', '.npmrc'].some((part) =>
                pattern.includes(part),
              )
            ? 'dependency-input'
            : pattern.includes('ignore')
              ? 'ignore-config'
              : 'tool-config',
    severity: 'error' as const,
  }));
  const entries = [
    ...defaultEntries,
    ...configPaths.map((pattern) => ({ pattern, kind: 'custom', severity: 'error' as const })),
    ...(policySurfaceConfig?.paths ?? []).map((entry) => ({
      ...entry,
      severity: entry.severity ?? 'error',
    })),
  ];
  const protectedPaths = [...new Set(entries.map((entry) => entry.pattern))].sort();
  const changes = changedPaths.flatMap((path) =>
    entries
      .filter((entry) => matchesPathPattern(path, entry.pattern))
      .map((entry) => ({ path, ...entry })),
  );
  const matched = [...new Set(changes.map((change) => change.path))].sort();
  return {
    protectedPaths,
    changedPaths: matched,
    changes,
    suppressionMarkers: suppressionMarkers ?? [],
    workflowChanged: matched.some((path) => path.startsWith('.github/workflows/')),
    complete: baseChangedPaths !== undefined && suppressionMarkers !== undefined,
  };
}

function buildRunPolicy(
  snapshot: GuardPolicySnapshot,
  base: string | undefined,
  changedFromBase: boolean,
  decisionIds: string[] = [],
): GuardRunPolicy {
  return {
    ...(snapshot.revision !== undefined ? { revision: snapshot.revision } : {}),
    fingerprint: snapshot.fingerprint,
    source: snapshot.source,
    ...(base ? { ref: base } : {}),
    ...(base ? { changedFromBase } : {}),
    ...(decisionIds.length > 0 ? { decisionIds } : {}),
  };
}

function stripControlCharacters(value: string): string {
  let output = '';
  for (const character of value) {
    const code = character.charCodeAt(0);
    output += code <= 0x1f || code === 0x7f ? ' ' : character;
  }
  return output;
}

function sanitizeCommand(command: string): string {
  return stripControlCharacters(command.slice(0, 2_000))
    .replace(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, '[REDACTED PRIVATE KEY]')
    .replace(
      /\b(?:sk_(?:live|test)_|pk_(?:live|test)_|AKIA|gh[pousr]_|github_pat_)[A-Za-z0-9_-]+/g,
      '[REDACTED TOKEN]',
    )
    .replace(
      new RegExp(
        '((?:api[_-]?key|secret|token|password|authorization|database[_-]?url)\\s*[:=]\\s*)[^\\s,}]+',
        'gi',
      ),
      '$1[REDACTED]',
    )
    .replace(
      /(--(?:token|secret|password|api-key|authorization)(?:=|\s+))[^\s]+/gi,
      '$1[REDACTED]',
    );
}

function sanitizeProjectChecks(results: ProjectCheckResults): ProjectCheckResults {
  return Object.fromEntries(
    Object.entries(results).map(([name, result]) => [
      name,
      { ...result, command: sanitizeCommand(result.command) },
    ]),
  );
}

function receiptCheck(result: CommandResult): GuardVerificationReceiptCheck {
  const command = sanitizeCommand(result.command);
  const args = command.trim().split(/\s+/).filter(Boolean).slice(1);
  return {
    status: result.status,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    command,
    args,
    execution:
      result.status === 'not-configured'
        ? 'not-configured'
        : result.stderr.includes('Unsafe or empty project command rejected.')
          ? 'rejected'
          : 'attempted',
  };
}

function effectiveVerifierInvocation(options: {
  checks: ProjectCheck[];
  tools: GuardToolMode;
  projectChecks: boolean;
  strict?: boolean | undefined;
  changedOnly?: boolean | undefined;
  policyBase?: string | undefined;
  failOnPolicyChange?: boolean | undefined;
  failOnProtectedChanges?: boolean | undefined;
}): { command: string; args: string[] } {
  const args = ['--tools=' + options.tools];
  if (!options.projectChecks) args.push('--no-project-checks');
  if (options.checks.length > 0) args.push(`--checks=${options.checks.join(',')}`);
  if (options.strict) args.push('--strict');
  if (options.changedOnly) args.push('--changed');
  if (options.policyBase) args.push(`--policy-base=${options.policyBase}`);
  if (options.failOnPolicyChange) args.push('--fail-on-policy-change');
  if (options.failOnProtectedChanges) args.push('--fail-on-protected-changes');
  return { command: 'codapult-guard verify', args };
}

function resolveGitCommit(root: string, ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  try {
    const commit = execFileSync('git', ['rev-parse', `${ref}^{commit}`], {
      cwd: root,
      stdio: 'pipe',
      timeout: 5_000,
    })
      .toString()
      .trim();
    return /^[0-9a-f]{40}$/i.test(commit) ? commit : undefined;
  } catch {
    return undefined;
  }
}

function hasWorkingTreeChanges(root: string): boolean {
  try {
    return (
      execFileSync('git', ['status', '--porcelain', '-z'], {
        cwd: root,
        stdio: 'pipe',
        timeout: 5_000,
      }).length > 0
    );
  } catch {
    return true;
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function baseFileDigest(root: string, revisions: string[], path: string): string | undefined {
  if (!path || path.startsWith('/') || path.split('/').includes('..')) return undefined;
  for (const revision of revisions) {
    try {
      const content = execFileSync('git', ['show', `${revision}:${path}`], {
        cwd: root,
        stdio: 'pipe',
        timeout: 5_000,
        maxBuffer: 32_000_000,
      });
      return sha256(content);
    } catch {
      // A deleted working-tree file may exist at HEAD even when absent from the base ref.
    }
  }
  return undefined;
}

function verificationScope(
  root: string,
  inventory: { path: string }[],
  changedPaths: string[],
  policy: GuardRunPolicy,
): GuardVerificationScope {
  const revisions = [resolveGitCommit(root, 'HEAD'), resolveGitCommit(root, policy.ref)].filter(
    (revision): revision is string => revision !== undefined,
  );
  const paths = [
    ...new Set(
      [...inventory.map((file) => file.path), ...changedPaths]
        .map((path) => path.replaceAll('\\', '/'))
        .filter((path) => !isGeneratedGuardArtifact(path)),
    ),
  ].sort();
  let complete = true;
  const files = paths.map((path) => {
    try {
      if (
        !path ||
        path.startsWith('/') ||
        /^[a-z]:\//i.test(path) ||
        path.split('/').includes('..')
      ) {
        complete = false;
        return { path, status: 'unavailable' as const };
      }
      const fullPath = resolve(root, path);
      const stats = lstatSync(fullPath);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        complete = false;
        return { path, status: 'unavailable' as const };
      }
      return { path, status: 'present' as const, sha256: sha256(readFileSync(fullPath)) };
    } catch {
      const digest = baseFileDigest(root, revisions, path);
      if (digest) return { path, status: 'deleted' as const, sha256: digest };
      complete = false;
      return { path, status: 'unavailable' as const };
    }
  });
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        algorithm: 'sha256',
        policyFingerprint: policy.fingerprint,
        tool: { name: '@codapult/guard', version: packageJson.version },
        files,
      }),
    )
    .digest('hex');
  return { algorithm: 'sha256', fingerprint, complete, stable: true, files };
}

function buildVerificationReceipt(
  root: string,
  policy: GuardRunPolicy,
  impact: GuardImpactAnalysis,
  checks: ProjectCheckResults,
  workspaceChecks: Record<string, ProjectCheckResults>,
  adapters: Partial<Record<GuardAdapter, CommandResult>>,
  architecture: GuardReport,
  contractIssues: GuardContractIssue[],
  stages: Record<string, 'ok' | 'fail' | 'skipped'>,
  policySurface: GuardVerificationReceiptPolicySurface,
  ciIntegrity: GuardVerificationCiIntegrity | undefined,
  scope: GuardVerificationScope,
  requiredStages: string[],
  incompleteStages: string[],
  effectiveInvocation: { command: string; args: string[] },
): Omit<GuardVerificationReceipt, 'runId' | 'generatedAt' | 'outcome' | 'gate' | 'subject'> &
  Pick<GuardVerificationReceipt, 'subject'> {
  const githubContext = readGuardGitHubContext(
    process.env.GITHUB_EVENT_NAME,
    process.env.GITHUB_EVENT_PATH,
    resolveGitCommit(root, 'HEAD'),
    process.env.GITHUB_SHA,
  );
  const baseCommit = resolveGitCommit(root, policy.ref);
  const baseChangedFiles = committedFilesSince(root, policy.ref);
  const workingTreeFiles = workingTreeChangedFiles(root) ?? impact.requestedFiles;
  const receiptChecks: Record<string, GuardVerificationReceiptCheck> = {};
  for (const [name, result] of Object.entries(checks)) {
    receiptChecks[name] = receiptCheck(result);
  }
  for (const [workspacePackage, packageChecks] of Object.entries(workspaceChecks)) {
    for (const [name, result] of Object.entries(packageChecks)) {
      receiptChecks[`${workspacePackage}:${name}`] = receiptCheck(result);
    }
  }
  for (const [name, result] of Object.entries(adapters)) {
    receiptChecks[`adapter:${name}`] = receiptCheck(result);
  }
  return {
    version: 1,
    kind: 'verification-receipt',
    subject: {
      ...(githubContext?.event ? { githubEvent: githubContext.event } : {}),
      ...(githubContext?.headSha ? { headSha: githubContext.headSha } : {}),
      ...(githubContext?.baseSha ? { baseSha: githubContext.baseSha } : {}),
      ...(githubContext?.mergeSha ? { mergeSha: githubContext.mergeSha } : {}),
      ...(policy.ref ? { baseRef: policy.ref } : {}),
      ...(baseCommit ? { baseCommit } : {}),
      ...(baseChangedFiles ? { baseChangedFiles } : {}),
      ...(workingTreeFiles.length > 0 ? { workingTreeFiles } : {}),
      changedFiles: [...new Set([...(baseChangedFiles ?? []), ...workingTreeFiles])].sort(),
      workingTreeDirty: workingTreeFiles.length > 0,
    },
    policy,
    verificationScope: scope,
    policySurface,
    ...(ciIntegrity ? { ciIntegrity } : {}),
    requiredStages,
    incompleteStages,
    effectiveInvocation,
    stages,
    checks: receiptChecks,
    findings: {
      total: architecture.findings.length,
      errors: architecture.findings.filter((finding) => finding.severity === 'error').length,
      warnings:
        architecture.findings.filter((finding) => finding.severity === 'warning').length +
        (policySurface.changes ?? []).filter((change) => change.severity === 'warning').length,
      waived: architecture.waived,
      waiverWarnings: architecture.waiverWarnings.length,
      expiredWaivers: architecture.expiredWaivers.length,
      fingerprints: architecture.findings.map((finding) => finding.fingerprint).sort(),
      ruleIds: [...new Set(architecture.findings.map((finding) => finding.ruleId))].sort(),
    },
    contractIssues: contractIssues.map((issue) => issue.contractId),
    decisionIds: policy.decisionIds ?? [],
    tool: { name: '@codapult/guard', version: packageJson.version },
  };
}

function buildPolicyGateReceipt(
  root: string,
  policy: GuardRunPolicy,
  policySurface: GuardPolicySurface,
  ciIntegrity: GuardVerificationCiIntegrity | undefined,
  stages: Record<string, 'ok' | 'fail' | 'skipped'>,
): Omit<GuardVerificationReceipt, 'runId' | 'generatedAt' | 'outcome' | 'gate' | 'subject'> &
  Pick<GuardVerificationReceipt, 'subject'> {
  const githubContext = readGuardGitHubContext(
    process.env.GITHUB_EVENT_NAME,
    process.env.GITHUB_EVENT_PATH,
    resolveGitCommit(root, 'HEAD'),
    process.env.GITHUB_SHA,
  );
  const baseChangedFiles = committedFilesSince(root, policy.ref);
  const workingTreeFiles = workingTreeChangedFiles(root) ?? [];
  const baseCommit = resolveGitCommit(root, policy.ref);
  return {
    version: 1,
    kind: 'verification-receipt',
    subject: {
      ...(githubContext?.event ? { githubEvent: githubContext.event } : {}),
      ...(githubContext?.headSha ? { headSha: githubContext.headSha } : {}),
      ...(githubContext?.baseSha ? { baseSha: githubContext.baseSha } : {}),
      ...(githubContext?.mergeSha ? { mergeSha: githubContext.mergeSha } : {}),
      ...(policy.ref ? { baseRef: policy.ref } : {}),
      ...(baseCommit ? { baseCommit } : {}),
      ...(baseChangedFiles ? { baseChangedFiles } : {}),
      ...(workingTreeFiles.length > 0 ? { workingTreeFiles } : {}),
      changedFiles: [...new Set([...(baseChangedFiles ?? []), ...workingTreeFiles])].sort(),
      workingTreeDirty: hasWorkingTreeChanges(root),
    },
    policy,
    policySurface,
    ...(ciIntegrity ? { ciIntegrity } : {}),
    requiredStages: [],
    incompleteStages: [],
    stages,
    checks: {},
    findings: {
      total: 0,
      errors: 0,
      warnings: 0,
      waived: 0,
      waiverWarnings: 0,
      expiredWaivers: 0,
      fingerprints: [],
      ruleIds: [],
    },
    contractIssues: [],
    decisionIds: policy.decisionIds ?? [],
    tool: { name: '@codapult/guard', version: packageJson.version },
  };
}

export function runGuardVerification(
  root: string,
  options: GuardVerificationOptions = {},
): GuardVerificationResult {
  const runContext = startGuardRun();
  const requirement = {
    status: 'delegated-to-review' as const,
    provided: Boolean(options.requirement?.trim()),
    message: options.requirement?.trim()
      ? 'Requirement text is included in semantic review input; deterministic verify does not judge natural-language acceptance criteria.'
      : 'Requirement satisfaction is evaluated by guard review using the task and diff.',
  };
  const runtimeStartedAt = Date.now();
  const runtime = inspectProjectRuntime(root);
  recordGuardRunStage(runContext, 'runtime', 'ok', runtimeStartedAt);
  if ((options.failOnPolicyChange || options.failOnProtectedChanges) && !options.policyBase) {
    const run = finishGuardRun(root, runContext, 'fail', 'policy-base');
    return {
      status: 'fail',
      outcome: 'fail',
      errorCode: 'GUARD_POLICY_BASE_INVALID',
      recoverable: true,
      checks: {},
      workspaceChecks: {},
      adapters: {},
      runtime,
      configError: 'Strict policy checks require `policyBase`.',
      contractIssues: [],
      requirement,
      run,
    };
  }
  let workingTreeState;
  try {
    workingTreeState = loadGuardWorkingTreePolicy(root);
  } catch (error) {
    const run = finishGuardRun(root, runContext, 'fail', 'configuration');
    return {
      status: 'fail',
      outcome: 'fail',
      errorCode: 'GUARD_CONFIG_INVALID',
      recoverable: true,
      checks: {},
      workspaceChecks: {},
      adapters: {},
      runtime,
      configError: error instanceof Error ? error.message : String(error),
      contractIssues: [],
      requirement,
      run,
    };
  }
  if (!workingTreeState) {
    const policyEnforcementFailed = options.failOnPolicyChange === true;
    const run = finishGuardRun(
      root,
      runContext,
      policyEnforcementFailed ? 'fail' : 'not-configured',
      policyEnforcementFailed ? 'policy-change' : 'configuration',
    );
    return {
      status: policyEnforcementFailed ? 'fail' : 'not-configured',
      outcome: policyEnforcementFailed ? 'fail' : 'not-configured',
      errorCode: policyEnforcementFailed ? 'GUARD_POLICY_CHANGED' : 'GUARD_NOT_CONFIGURED',
      recoverable: true,
      checks: {},
      workspaceChecks: {},
      adapters: {},
      runtime,
      contractIssues: [],
      requirement,
      run,
    };
  }

  let policySnapshot: GuardPolicySnapshot;
  let workingTreeSnapshot: GuardPolicySnapshot;
  let policyChanged: boolean;
  let policySurface: GuardVerificationResult['policySurface'];
  let ciIntegrity: GuardVerificationCiIntegrity | undefined;
  let uncheckedProtectedPaths: string[];
  let policyDecisionIds: string[] = [];
  try {
    workingTreeSnapshot = workingTreeState.snapshot;
    const baseSnapshot = options.policyBase
      ? loadGuardPolicyAtRevision(root, options.policyBase)
      : undefined;
    if (options.policyBase && !baseSnapshot) {
      const run = finishGuardRun(root, runContext, 'fail', 'policy-base');
      return {
        status: 'fail',
        outcome: 'fail',
        errorCode: 'GUARD_POLICY_BASE_INVALID',
        recoverable: true,
        checks: {},
        workspaceChecks: {},
        adapters: {},
        runtime,
        configError: `Guard policy was not found at Git ref: ${options.policyBase}`,
        contractIssues: [],
        requirement,
        run,
      };
    }
    policySnapshot = baseSnapshot ?? workingTreeSnapshot;
    policyChanged =
      baseSnapshot !== undefined && baseSnapshot.fingerprint !== workingTreeSnapshot.fingerprint;
    const policySurfaceStartedAt = Date.now();
    policySurface = getPolicySurface(
      root,
      options.policyBase,
      baseSnapshot?.config.protectedPaths ?? [],
      baseSnapshot?.config.policySurface,
    );
    recordGuardRunStage(
      runContext,
      'policy-surface',
      policySurface.complete ? 'ok' : 'skipped',
      policySurfaceStartedAt,
      policySurface.complete ? undefined : 'A policy base was not available for comparison.',
    );
    const ciAuditStartedAt = Date.now();
    ciIntegrity = auditGitHubActions(root, policySnapshot.config.githubActions, options.policyBase);
    const contractedWorkflowPaths = new Set(
      policySnapshot.config.githubActions?.workflows.map((workflow) => workflow.path) ?? [],
    );
    uncheckedProtectedPaths = [
      ...new Set(
        policySurface.changes
          .filter((change) => change.severity === 'error')
          .map((change) => change.path)
          .filter(
            (path) => !(path.startsWith('.github/workflows/') && contractedWorkflowPaths.has(path)),
          ),
      ),
    ];
    recordGuardRunStage(
      runContext,
      'ci-integrity',
      ciIntegrity === undefined
        ? 'skipped'
        : ciIntegrity.status === 'ok'
          ? 'ok'
          : ciIntegrity.status === 'policy-weakened'
            ? 'fail'
            : 'skipped',
      ciAuditStartedAt,
      ciIntegrity === undefined ? 'No GitHub Actions integrity contract is configured.' : undefined,
    );
    if (policySnapshot.source === 'working-tree') {
      policyDecisionIds = (workingTreeState.proposals?.decisions ?? [])
        .filter((decision) => decision.policyFingerprint === policySnapshot.fingerprint)
        .map(
          (decision) =>
            decision.decisionId ??
            `${decision.proposalId ?? 'unknown'}:${decision.type}:${decision.id}`,
        )
        .sort();
    }
    if (options.failOnPolicyChange && policyChanged) {
      const policy = buildRunPolicy(
        policySnapshot,
        options.policyBase,
        policyChanged,
        policyDecisionIds,
      );
      const run = finishGuardRun(
        root,
        runContext,
        'fail',
        'policy-change',
        'verify',
        policy,
        buildPolicyGateReceipt(
          root,
          policy,
          policySurface,
          ciIntegrity,
          Object.fromEntries(
            Object.entries(runContext.stages).map(([name, stage]) => [name, stage.status]),
          ),
        ),
      );
      return {
        status: 'fail',
        outcome: 'fail',
        errorCode: 'GUARD_POLICY_CHANGED',
        recoverable: true,
        checks: {},
        workspaceChecks: {},
        adapters: {},
        runtime,
        configError: 'Guard policy changed relative to the supplied Git base ref.',
        contractIssues: [],
        requirement,
        run,
        policy,
        policyChanged,
        policySurface,
        ...(ciIntegrity ? { ciIntegrity } : {}),
      };
    }
    if (
      options.failOnProtectedChanges &&
      (!policySurface.complete ||
        uncheckedProtectedPaths.length > 0 ||
        policySurface.suppressionMarkers.length > 0)
    ) {
      const policy = buildRunPolicy(
        policySnapshot,
        options.policyBase,
        policyChanged,
        policyDecisionIds,
      );
      const run = finishGuardRun(
        root,
        runContext,
        'fail',
        'protected-path-change',
        'verify',
        policy,
        buildPolicyGateReceipt(
          root,
          policy,
          policySurface,
          ciIntegrity,
          Object.fromEntries(
            Object.entries(runContext.stages).map(([name, stage]) => [name, stage.status]),
          ),
        ),
      );
      return {
        status: 'fail',
        outcome: 'fail',
        errorCode: policySurface.complete
          ? 'GUARD_PROTECTED_PATH_CHANGED'
          : 'GUARD_POLICY_SURFACE_INCOMPLETE',
        recoverable: true,
        checks: {},
        workspaceChecks: {},
        adapters: {},
        runtime,
        configError: policySurface.complete
          ? `Verification-sensitive paths or inline suppression markers changed: ${[
              ...uncheckedProtectedPaths,
              ...policySurface.suppressionMarkers,
            ].join(', ')}`
          : 'Could not inspect the complete policy surface against the base ref; strict verification failed closed.',
        contractIssues: [],
        requirement,
        run,
        policy,
        policyChanged,
        policySurface,
        ...(ciIntegrity ? { ciIntegrity } : {}),
      };
    }
  } catch (error) {
    const run = finishGuardRun(root, runContext, 'fail', 'policy-base');
    return {
      status: 'fail',
      outcome: 'fail',
      errorCode: 'GUARD_POLICY_BASE_INVALID',
      recoverable: true,
      checks: {},
      workspaceChecks: {},
      adapters: {},
      runtime,
      configError: error instanceof Error ? error.message : String(error),
      contractIssues: [],
      requirement,
      run,
    };
  }
  const policy = buildRunPolicy(
    policySnapshot,
    options.policyBase,
    policyChanged,
    policyDecisionIds,
  );

  const agentConfig = policySnapshot.agentConfig;
  const projectChecks = options.projectChecks ?? agentConfig.completionGate.projectChecks;
  const checks = projectChecks ? (options.checks ?? agentConfig.completionGate.checks) : [];
  const discoveryStartedAt = Date.now();
  const workspaceModel = discoverProject(root);
  const scopeChangedPaths = changedFilesSince(root, policy.ref) ?? workspaceModel.git.changedFiles;
  const initialScope = verificationScope(root, workspaceModel.files, scopeChangedPaths, policy);
  const checksStartedAt = Date.now();
  const results = runProjectChecks(root, checks, { timeout: options.timeout });
  recordGuardRunStage(
    runContext,
    'project-checks',
    projectChecks ? 'ok' : 'skipped',
    checksStartedAt,
  );
  const impact = analyzeProjectImpact(
    workspaceModel,
    options.changedOnly === false
      ? workspaceModel.modules.map((module) => module.path)
      : workspaceModel.git.changedFiles,
    policySnapshot.config.contracts ?? [],
  );
  const workspaceChecks = runWorkspaceProjectChecks(
    root,
    workspaceModel.project.workspacePackages ?? [],
    checks,
    {
      timeout: options.timeout,
      rootResults: results,
    },
  );
  recordGuardRunStage(runContext, 'discovery-impact', 'ok', discoveryStartedAt);
  const toolMode = options.tools ?? agentConfig.tools;
  const adaptersStartedAt = Date.now();
  const adapters =
    toolMode === 'off'
      ? {}
      : runProjectAdapters(root, {
          mode: toolMode,
          timeout: options.timeout,
          tooling: agentConfig.tooling,
        });
  recordGuardRunStage(
    runContext,
    'adapters',
    toolMode === 'off' ? 'skipped' : 'ok',
    adaptersStartedAt,
  );

  const architectureStartedAt = Date.now();
  const architecture = scanGuard(root, policySnapshot.config, {
    changedOnly: options.changedOnly,
    baseline: policySnapshot.baseline,
    includeArchitectureInsights: true,
    waivers: policySnapshot.waivers,
  });
  const contractIssues = validateGuardPolicy(root, policySnapshot.config);
  recordGuardRunStage(runContext, 'architecture-policy', 'ok', architectureStartedAt);
  const finalWorkspaceModel = discoverProject(root);
  const finalScope = verificationScope(
    root,
    finalWorkspaceModel.files,
    changedFilesSince(root, policy.ref) ?? finalWorkspaceModel.git.changedFiles,
    policy,
  );
  const scopeStable =
    initialScope.complete &&
    finalScope.complete &&
    initialScope.fingerprint === finalScope.fingerprint;
  const scope = {
    ...initialScope,
    complete: initialScope.complete && finalScope.complete,
    stable: scopeStable,
  };
  recordGuardRunStage(
    runContext,
    'verification-scope',
    scope.complete && scope.stable ? 'ok' : 'skipped',
    discoveryStartedAt,
    scope.complete && scope.stable
      ? undefined
      : 'The complete verification input scope could not be hashed consistently for the entire run.',
  );
  const commandFailed = Object.values(results).some((result) => result.status === 'failed');
  const workspaceCommandFailed = Object.values(workspaceChecks).some((packageResults) =>
    Object.values(packageResults).some((result) => result.status === 'failed'),
  );
  const adapterFailed = Object.values(adapters).some((result) => result.status === 'failed');
  const missingProjectChecks =
    projectChecks &&
    (checks.length === 0 ||
      Object.values(results).some((result) => result.status === 'not-configured') ||
      Object.values(workspaceChecks).some((packageResults) =>
        Object.values(packageResults).some((result) => result.status === 'not-configured'),
      ));
  const missingAdapterTools =
    options.strict && Object.values(adapters).some((result) => result.status === 'not-configured');
  const runtimeFailed = projectChecks && !runtime.compatible;
  const architectureFailed = architecture.findings.some((finding) => finding.severity === 'error');
  const expiredWaivers = architecture.expiredWaivers.length > 0;
  const architectureWarnings =
    architecture.findings.some((finding) => finding.severity === 'warning') ||
    (architecture.waiverWarnings ?? []).length > 0;
  const policySurfaceWarnings = policySurface.changes.some(
    (change) => change.severity === 'warning',
  );
  const otherFailures =
    runtimeFailed ||
    commandFailed ||
    workspaceCommandFailed ||
    adapterFailed ||
    architectureFailed ||
    expiredWaivers ||
    contractIssues.length > 0 ||
    missingProjectChecks ||
    missingAdapterTools;
  const ciWeakened = ciIntegrity?.status === 'policy-weakened';
  const ciIncomplete = ciIntegrity?.status === 'incomplete';
  const failed = otherFailures || ciWeakened;
  const projectChecksFailed =
    commandFailed || workspaceCommandFailed || missingProjectChecks || runtimeFailed;
  const adaptersFailed = adapterFailed || missingAdapterTools;
  runContext.stages['project-checks'] = {
    ...runContext.stages['project-checks'],
    status: projectChecks ? (projectChecksFailed ? 'fail' : 'ok') : 'skipped',
  };
  runContext.stages.adapters = {
    ...runContext.stages.adapters,
    status:
      toolMode === 'off' ||
      !Object.values(adapters).some((result) => result.status !== 'not-configured')
        ? 'skipped'
        : adaptersFailed
          ? 'fail'
          : 'ok',
  };
  runContext.stages.runtime = {
    ...runContext.stages.runtime,
    status: projectChecks ? (runtimeFailed ? 'fail' : 'ok') : 'skipped',
  };
  runContext.stages['architecture-policy'] = {
    ...runContext.stages['architecture-policy'],
    status: architectureFailed || expiredWaivers || contractIssues.length > 0 ? 'fail' : 'ok',
  };
  const requiredStages = agentConfig.completionGate.requiredStages ?? ['architecture-policy'];
  const effectiveRequiredStages = [
    ...new Set([
      ...requiredStages,
      ...(policySnapshot.source === 'git-ref' ? ['policy-surface' as const] : []),
      ...(ciIntegrity !== undefined ? ['ci-integrity' as const] : []),
      'verification-scope' as const,
    ]),
  ];
  const effectiveIncompleteStages = effectiveRequiredStages.filter(
    (stage) => runContext.stages[stage].status !== 'ok',
  );
  const incomplete = ciIncomplete || effectiveIncompleteStages.length > 0;
  const outcome =
    ciWeakened && !otherFailures
      ? 'policy-weakened'
      : classifyGuardOutcome({
          errors: failed ? 1 : 0,
          warnings: architectureWarnings || policySurfaceWarnings ? 1 : 0,
          incomplete: !failed && incomplete,
        });
  const gate = ciWeakened
    ? 'ci-integrity'
    : architectureFailed || expiredWaivers
      ? 'architecture'
      : contractIssues.length > 0
        ? 'contracts'
        : commandFailed || workspaceCommandFailed
          ? 'project-checks'
          : adapterFailed
            ? 'adapters'
            : missingProjectChecks
              ? 'project-checks'
              : missingAdapterTools
                ? 'required-tools'
                : runtimeFailed
                  ? 'runtime'
                  : incomplete
                    ? 'required-stages'
                    : 'none';
  const receipt = buildVerificationReceipt(
    root,
    policy,
    impact,
    results,
    workspaceChecks,
    adapters,
    architecture,
    contractIssues,
    Object.fromEntries(
      Object.entries(runContext.stages).map(([name, stage]) => [name, stage.status]),
    ),
    policySurface,
    ciIntegrity,
    scope,
    effectiveRequiredStages,
    effectiveIncompleteStages,
    effectiveVerifierInvocation({
      checks,
      tools: toolMode,
      projectChecks,
      strict: options.strict,
      changedOnly: options.changedOnly,
      policyBase: options.policyBase,
      failOnPolicyChange: options.failOnPolicyChange,
      failOnProtectedChanges: options.failOnProtectedChanges,
    }),
  );
  const run = finishGuardRun(root, runContext, outcome, gate, 'verify', policy, receipt);
  return {
    status:
      outcome === 'policy-weakened'
        ? 'policy-weakened'
        : failed
          ? 'fail'
          : incomplete
            ? 'incomplete'
            : 'ok',
    ...(ciWeakened || ciIncomplete || incomplete
      ? {
          errorCode: ciWeakened
            ? 'GUARD_CI_POLICY_WEAKENED'
            : ciIncomplete
              ? 'GUARD_CI_POLICY_INCOMPLETE'
              : 'GUARD_REQUIRED_STAGE_INCOMPLETE',
        }
      : {}),
    outcome,
    tools: toolMode,
    checks: sanitizeProjectChecks(results),
    workspaceChecks: Object.fromEntries(
      Object.entries(workspaceChecks).map(([name, packageChecks]) => [
        name,
        sanitizeProjectChecks(packageChecks),
      ]),
    ),
    adapters: Object.fromEntries(
      Object.entries(adapters).map(([name, result]) => [
        name,
        { ...result, command: sanitizeCommand(result.command) },
      ]),
    ),
    runtime,
    architecture,
    impact,
    contractIssues,
    requirement,
    run,
    policy,
    ...(policy.changedFromBase !== undefined ? { policyChanged: policy.changedFromBase } : {}),
    policySurface,
    ...(ciIntegrity ? { ciIntegrity } : {}),
    requiredStages: effectiveRequiredStages,
    incompleteStages: effectiveIncompleteStages,
  };
}
