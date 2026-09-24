import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { Project, SyntaxKind, type SourceFile } from 'ts-morph';
import { buildModuleTargetGraph, type ProjectModel } from './discovery/discovery.js';
import {
  clearDiscoveryCache,
  discoverProject,
  discoverProjectWithMetrics,
  findGuardRoot,
} from './discovery/discovery.js';
import { config } from './config.js';
import { assessGuardPacks, detectGuardPacks } from './analysis/packs.js';
import { analyzeProjectImpact, type GuardImpactAnalysis } from './analysis/impact.js';
import {
  guardAgentConfigSchema,
  guardConfigSchema,
  guardContractsFileSchema,
  guardProposalSchema,
} from './policy/schemas.js';
import type {
  GuardAdapterName,
  GuardApprovalMode,
  GuardContractKind,
  GuardBudgetMetric,
  GuardRuleKind,
  GuardRuleStatus,
  GuardSeverity,
  GuardToolMode,
} from './model/types.js';

export type {
  GuardAdapterName,
  GuardApprovalMode,
  GuardContractKind,
  GuardBudgetMetric,
  GuardRuleKind,
  GuardRuleStatus,
  GuardSeverity,
  GuardToolMode,
} from './model/types.js';
export type GuardOutcomeStatus = 'pass' | 'fail' | 'warning' | 'needs-review' | 'not-configured';

export interface GuardOutcomeInput {
  configured?: boolean | undefined;
  errors?: number | undefined;
  warnings?: number | undefined;
  needsReview?: boolean | undefined;
}

interface GuardStateLockOptions {
  waitMs?: number | undefined;
  noWait?: boolean | undefined;
}

interface GuardBaselineUpdateOptions {
  add?: string[] | undefined;
  remove?: string[] | undefined;
  reason?: string | undefined;
}

interface GuardConfigWriteOptions extends GuardStateLockOptions {
  expectedRevision?: number | undefined;
}

interface GuardPendingProposal {
  id: string;
  type: 'rule' | 'contract';
}

export interface GuardSensitiveText {
  value: string;
  redacted: boolean;
  redactionCount: number;
}

interface GuardReviewDiff {
  diff: string;
  truncated: boolean;
  redacted: boolean;
  changedFiles: string[];
  changes: GuardFileChange[];
  error?: string | undefined;
}

export interface GuardInitializationResult {
  config: GuardConfig;
  report: GuardReport;
}

export function classifyGuardOutcome(input: GuardOutcomeInput): GuardOutcomeStatus {
  if (input.configured === false) return 'not-configured';
  if ((input.errors ?? 0) > 0) return 'fail';
  if (input.needsReview) return 'needs-review';
  return (input.warnings ?? 0) > 0 ? 'warning' : 'pass';
}
export interface GuardContract {
  id: string;
  statement: string;
  kind?: GuardContractKind | undefined;
  severity?: GuardSeverity | undefined;
  scope?: string[] | undefined;
  entrypoints?: string[] | undefined;
  exclude?: string[] | undefined;
  guidance?: string[] | undefined;
  references?: string[] | undefined;
  mustImport?: string[] | undefined;
  mustNotImport?: string[] | undefined;
  mustCall?: string[] | undefined;
  fromPackages?: string[] | undefined;
  mustNotImportPackages?: string[] | undefined;
  status?: GuardRuleStatus | undefined;
  confidence?: 'high' | 'medium' | 'low' | undefined;
  evidence?: string[] | undefined;
}

export interface GuardRule {
  id: string;
  description: string;
  severity: GuardSeverity;
  kind: GuardRuleKind;
  patterns: string[];
  files?: string[] | undefined;
  status?: GuardRuleStatus | undefined;
  confidence?: 'high' | 'medium' | 'low' | undefined;
  evidence?: string[] | undefined;
}

export interface GuardBudget {
  id: string;
  description: string;
  metric: GuardBudgetMetric;
  scope: string[];
  limit: number;
  severity: GuardSeverity;
  reason: string;
  status?: GuardRuleStatus | undefined;
  evidence?: string[] | undefined;
}

export interface GuardConfig {
  version: 1;
  revision?: number | undefined;
  contentFingerprint?: string | undefined;
  rules: GuardRule[];
  contracts?: GuardContract[] | undefined;
  budgets?: GuardBudget[] | undefined;
  approval?: GuardApprovalPolicy | undefined;
}

export interface GuardApprovalPolicy {
  mode: GuardApprovalMode;
  allowMcpApproval: boolean;
  requireDistinctActor: boolean;
}

export interface GuardProposalFile {
  version: 1;
  generatedAt: string;
  proposalId?: string | undefined;
  projectFingerprint?: string | undefined;
  revision?: number | undefined;
  contentFingerprint?: string | undefined;
  rules: GuardRule[];
  contracts: GuardContract[];
  questions: string[];
  decisions?: GuardProposalDecision[] | undefined;
}

export interface GuardProposalDecision {
  id: string;
  type: 'rule' | 'contract';
  decision: 'approved' | 'rejected';
  decidedAt: string;
  proposalId?: string | undefined;
  proposalFingerprint?: string | undefined;
  revision?: number | undefined;
  source?: 'cli' | 'mcp' | 'external' | undefined;
  actor?: string | undefined;
  commit?: string | undefined;
}

export type GuardProposalFreshness = 'current' | 'stale' | 'unknown';

export interface GuardAgentConfig {
  version: 1;
  tools: GuardToolMode;
  tooling: Partial<Record<GuardAdapterName, { script: string; enabled: boolean }>>;
  completionGate: {
    enabled: boolean;
    maxIterations: number;
    projectChecks: boolean;
    checks: ('lint' | 'typecheck' | 'test' | 'build')[];
  };
}

export interface GuardFinding {
  ruleId: string;
  severity: GuardSeverity;
  file: string;
  line: number;
  importPath: string;
  resolvedPath?: string | undefined;
  message: string;
  fingerprint: string;
}

export interface GuardFileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  previousPath?: string | undefined;
}

export interface GuardContractIssue {
  contractId: string;
  field: 'scope' | 'reference' | 'definition';
  value: string;
  message: string;
}

export interface GuardReport {
  configured: boolean;
  findings: GuardFinding[];
  suppressed: number;
  scannedFiles: number;
}

interface ScanGuardOptions {
  changedOnly?: boolean | undefined;
  changedFiles?: Set<string> | undefined;
  baseline?: Set<string> | undefined;
  includeArchitectureInsights?: boolean | undefined;
}

export interface GuardReviewPacket {
  version: 1;
  outcome: GuardOutcomeStatus;
  diffBase?: string | undefined;
  changedFiles: string[];
  changes: GuardFileChange[];
  diff: string;
  truncated: boolean;
  redacted: boolean;
  diffError?: string | undefined;
  project: ProjectModel;
  contracts: GuardContract[];
  requirement?: string | undefined;
  deterministicFindings: GuardFinding[];
  impact: GuardImpactAnalysis;
  reviewInstructions: string[];
}

export const GUARD_DIR = `.${config.appName}/guard`;
export const GUARD_RULES_FILE = `${GUARD_DIR}/rules.json`;
export const GUARD_BASELINE_FILE = `${GUARD_DIR}/baseline.json`;
export const GUARD_BASELINE_META_FILE = `${GUARD_DIR}/baseline-meta.json`;
export const GUARD_PROJECT_FILE = `${GUARD_DIR}/project.json`;
export const GUARD_HISTORY_DIR = `${GUARD_DIR}/history`;
export const GUARD_ARCHITECTURE_FILE = `${GUARD_DIR}/architecture.json`;
export const GUARD_CONVENTIONS_FILE = `${GUARD_DIR}/conventions.json`;
export const GUARD_AGENT_FILE = `${GUARD_DIR}/agent.json`;
export const GUARD_CONTRACTS_FILE = `${GUARD_DIR}/contracts.json`;
export const GUARD_PROPOSALS_FILE = `${GUARD_DIR}/proposals.json`;
export const GUARD_STATE_DIR = `${GUARD_DIR}/state`;
export const GUARD_STATE_GENERATIONS_DIR = `${GUARD_STATE_DIR}/generations`;
export const GUARD_STATE_CURRENT_FILE = `${GUARD_STATE_DIR}/current.json`;
const GUARD_STATE_LOCK_FILE = `${GUARD_DIR}/.state.lock`;

export const defaultGuardConfig: GuardConfig = {
  version: 1,
  rules: [],
  contracts: [],
  approval: {
    mode: 'local',
    allowMcpApproval: true,
    requireDistinctActor: false,
  },
};

export const defaultGuardAgentConfig: GuardAgentConfig = {
  version: 1,
  tools: 'auto',
  tooling: {},
  completionGate: {
    enabled: true,
    maxIterations: 3,
    projectChecks: true,
    checks: ['lint', 'typecheck', 'test', 'build'],
  },
};

export class GuardAlreadyInitializedError extends Error {
  constructor() {
    super(`Guard is already initialized (${GUARD_BASELINE_FILE} exists).`);
    this.name = 'GuardAlreadyInitializedError';
  }
}

export class GuardConfigError extends Error {
  constructor(path: string) {
    super(`Guard configuration is invalid or unsupported: ${path}`);
    this.name = 'GuardConfigError';
  }
}

export class GuardStateBusyError extends Error {
  constructor(path: string) {
    super(`Guard state is being updated by another process: ${path}`);
    this.name = 'GuardStateBusyError';
  }
}

export class GuardStateStaleError extends Error {
  constructor() {
    super('Guard state changed while this operation was running.');
    this.name = 'GuardStateStaleError';
  }
}

export class GuardBaselineReasonError extends Error {
  constructor() {
    super('A reason is required when changing the Guard baseline.');
    this.name = 'GuardBaselineReasonError';
  }
}

interface GuardStateLock {
  pid: number;
  hostname: string;
  command: string;
  token: string;
  createdAt: string;
  expiresAt: string;
}

const activeStateLocks = new Map<string, number>();

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string | undefined }).code === 'EPERM';
  }
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function removeLockFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Lock cleanup is best effort. A later invocation can recover an orphaned lock by PID.
  }
}

function readStateLock(path: string): GuardStateLock | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as GuardStateLock;
    const hasValidDate = (candidate: string): boolean =>
      typeof candidate === 'string' && Number.isFinite(Date.parse(candidate));
    return Number.isInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.hostname === 'string' &&
      value.hostname.length > 0 &&
      typeof value.command === 'string' &&
      typeof value.token === 'string' &&
      value.token.length > 0 &&
      hasValidDate(value.createdAt) &&
      hasValidDate(value.expiresAt)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function getActiveStateRoot(path: string): string | undefined {
  const normalizedPath = resolve(path);
  return [...activeStateLocks.keys()]
    .filter((root) => normalizedPath === root || normalizedPath.startsWith(`${root}${sep}`))
    .sort((left, right) => right.length - left.length)[0];
}

function safeGeneration(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._-]+$/.test(value);
}

export function withGuardStateLock<T>(
  root: string,
  callback: () => T,
  options: GuardStateLockOptions = {},
): T {
  const normalizedRoot = resolve(root);
  const activeDepth = activeStateLocks.get(normalizedRoot);
  if (activeDepth !== undefined) {
    activeStateLocks.set(normalizedRoot, activeDepth + 1);
    try {
      return callback();
    } finally {
      activeStateLocks.set(normalizedRoot, activeDepth);
    }
  }
  const lockPath = resolve(normalizedRoot, GUARD_STATE_LOCK_FILE);
  mkdirSync(dirname(lockPath), { recursive: true });
  const startedAt = Date.now();
  const waitMs = options.noWait ? 0 : (options.waitMs ?? 30_000);
  let lock: GuardStateLock | undefined;
  let delay = 25;
  while (!lock) {
    const now = new Date();
    const candidate: GuardStateLock = {
      pid: process.pid,
      hostname: hostname(),
      command: process.argv.join(' '),
      token: randomUUID(),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 300_000).toISOString(),
    };
    try {
      writeFileSync(lockPath, `${JSON.stringify(candidate)}\n`, { encoding: 'utf8', flag: 'wx' });
      lock = candidate;
      break;
    } catch (error) {
      if ((error as { code?: string | undefined }).code !== 'EEXIST') throw error;
      const owner = readStateLock(lockPath);
      const ownerDead = owner?.hostname === hostname() && !processIsAlive(owner.pid);
      let malformedStale = false;
      if (owner === undefined) {
        try {
          malformedStale = Date.now() - statSync(lockPath).mtimeMs > 60_000;
        } catch {
          // The lock disappeared between the failed create and stat.
        }
      }
      if (ownerDead || malformedStale) {
        try {
          unlinkSync(lockPath);
          continue;
        } catch {
          // The owner or another waiter changed the lock; retry normally.
        }
      }
      if (Date.now() - startedAt >= waitMs) throw new GuardStateBusyError(lockPath);
      sleepSync(Math.min(delay, Math.max(1, waitMs - (Date.now() - startedAt))));
      delay = Math.min(delay * 2, 500);
    }
  }
  activeStateLocks.set(normalizedRoot, 1);
  try {
    return callback();
  } finally {
    activeStateLocks.delete(normalizedRoot);
    const current = readStateLock(lockPath);
    if (current?.token === lock.token) {
      removeLockFile(lockPath);
    }
  }
}

function isGuardConfig(value: unknown): value is GuardConfig {
  return guardConfigSchema.safeParse(value).success;
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function atomicWriteFile(path: string, content: string): void {
  if (getActiveStateRoot(path) !== undefined) {
    const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
    writeFileSync(temporaryPath, content, 'utf8');
    renameSync(temporaryPath, path);
    return;
  }
  const lockPath = `${path}.lock`;
  let lockAcquired = false;
  try {
    try {
      writeFileSync(lockPath, `${process.pid}\n`, { encoding: 'utf8', flag: 'wx' });
      lockAcquired = true;
    } catch (error) {
      if ((error as { code?: string | undefined }).code === 'EEXIST') {
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > 60_000) {
            unlinkSync(lockPath);
            writeFileSync(lockPath, `${process.pid}\n`, { encoding: 'utf8', flag: 'wx' });
            lockAcquired = true;
          }
        } catch {
          // Another writer may have replaced or removed the lock.
        }
      }
      if (!lockAcquired) throw new GuardStateBusyError(path);
    }
    const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
    writeFileSync(temporaryPath, content, 'utf8');
    renameSync(temporaryPath, path);
  } finally {
    if (lockAcquired) {
      removeLockFile(lockPath);
    }
  }
}

function writeGuardArtifact(root: string, relativePath: string, value: unknown): void {
  withGuardStateLock(root, () => {
    mkdirSync(resolve(root, GUARD_DIR), { recursive: true });
    atomicWriteFile(resolve(root, relativePath), `${JSON.stringify(value, null, 2)}\n`);
  });
}

function hasProjectTool(model: ProjectModel, name: string): boolean {
  return (
    Object.keys({ ...model.project.dependencies, ...model.project.devDependencies }).some(
      (dependency) => dependency === name || dependency.endsWith(`/${name}`),
    ) || Object.values(model.project.scripts).some((script) => script.includes(name))
  );
}

function ensureGeneratedStateIgnored(root: string, model: ProjectModel): void {
  const ignoreFiles = [
    ...(hasProjectTool(model, 'prettier') ? ['.prettierignore'] : []),
    ...(hasProjectTool(model, 'biome') ? ['.biomeignore'] : []),
    ...(hasProjectTool(model, 'oxfmt') && !hasProjectTool(model, 'prettier')
      ? ['.prettierignore']
      : []),
  ];
  const marker = `# ${config.projectName} Guard generated state`;
  for (const ignoreFile of ignoreFiles) {
    const path = resolve(root, ignoreFile);
    const content = existsSync(path) ? readFileSync(path, 'utf8') : '';
    if (
      content.includes(marker) ||
      content.split(/\r?\n/).some((line) => line.trim() === `${GUARD_DIR}/`)
    ) {
      continue;
    }
    const prefix = content.length > 0 && !content.endsWith('\n') ? `${content}\n` : content;
    atomicWriteFile(path, `${prefix}${marker}\n${GUARD_DIR}/\n`);
  }
}

export function isGuardContractsFile(
  value: unknown,
): value is { version: 1; contracts: GuardContract[] } {
  return guardContractsFileSchema.safeParse(value).success;
}

export function isGuardProposalFile(value: unknown): value is GuardProposalFile {
  return guardProposalSchema.safeParse(value).success;
}

export function fingerprintProjectModel(model: ProjectModel): string {
  return createHash('sha256').update(JSON.stringify(model)).digest('hex');
}

export function fingerprintGuardConfig(guardConfig: GuardConfig): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        rules: guardConfig.rules,
        contracts: guardConfig.contracts ?? [],
        budgets: guardConfig.budgets ?? [],
        approval: guardConfig.approval ?? defaultGuardConfig.approval,
      }),
    )
    .digest('hex');
}

export function getGuardProposalFreshness(
  model: ProjectModel,
  proposals: GuardProposalFile | undefined,
): GuardProposalFreshness {
  if (!proposals?.projectFingerprint) return 'unknown';
  return proposals.projectFingerprint === fingerprintProjectModel(model) ? 'current' : 'stale';
}

function loadGuardConfigUnlocked(root: string): GuardConfig | undefined {
  const rulesPath = resolve(root, GUARD_RULES_FILE);
  if (!existsSync(rulesPath)) return undefined;
  const value = readJson(rulesPath);
  if (!isGuardConfig(value)) throw new GuardConfigError(GUARD_RULES_FILE);
  const contractsPath = resolve(root, GUARD_CONTRACTS_FILE);
  if (existsSync(contractsPath)) {
    const contractFile = readJson(contractsPath);
    if (!isGuardContractsFile(contractFile)) throw new GuardConfigError(GUARD_CONTRACTS_FILE);
    return {
      ...value,
      contracts: contractFile.contracts,
      budgets: value.budgets ?? [],
      approval: value.approval ?? defaultGuardConfig.approval,
    };
  }
  return {
    ...value,
    contracts: value.contracts ?? [],
    budgets: value.budgets ?? [],
    approval: value.approval ?? defaultGuardConfig.approval,
  };
}

export function loadGuardConfig(root: string): GuardConfig | undefined {
  if (!existsSync(resolve(root, GUARD_DIR))) return loadGuardConfigUnlocked(root);
  return withGuardStateLock(root, () => loadGuardConfigUnlocked(root));
}

export function loadGuardProposals(root: string): GuardProposalFile | undefined {
  const path = resolve(root, GUARD_PROPOSALS_FILE);
  if (!existsSync(path)) return undefined;
  const value = readJson(path);
  if (value === undefined || !isGuardProposalFile(value)) {
    throw new GuardConfigError(GUARD_PROPOSALS_FILE);
  }
  return value;
}

export function isGuardAgentConfig(value: unknown): value is GuardAgentConfig {
  return guardAgentConfigSchema.safeParse(value).success;
}

export function loadGuardAgentConfig(root: string): GuardAgentConfig {
  const path = resolve(root, GUARD_AGENT_FILE);
  if (!existsSync(path)) return defaultGuardAgentConfig;
  const value = readJson(path);
  if (!isGuardAgentConfig(value)) throw new GuardConfigError(GUARD_AGENT_FILE);
  return value;
}

export function writeGuardAgentConfig(root: string, agentConfig = defaultGuardAgentConfig): void {
  writeGuardArtifact(root, GUARD_AGENT_FILE, agentConfig);
}

export function loadBaseline(root: string): Set<string> {
  const path = resolve(root, GUARD_BASELINE_FILE);
  if (!existsSync(path)) return new Set();
  const value = readJson(path);
  if (!Array.isArray(value)) throw new GuardConfigError(GUARD_BASELINE_FILE);
  return new Set(value.filter((item): item is string => typeof item === 'string'));
}

export function updateBaseline(
  root: string,
  options: GuardBaselineUpdateOptions = {},
): Set<string> {
  if ((options.add?.length ?? 0) > 0 || (options.remove?.length ?? 0) > 0) {
    if (!options.reason?.trim()) throw new GuardBaselineReasonError();
  }
  return withGuardStateLock(root, () => {
    const next = loadBaseline(root);
    for (const fingerprint of options.add ?? []) next.add(fingerprint);
    for (const fingerprint of options.remove ?? []) next.delete(fingerprint);
    const fingerprints = [...next].sort();
    const metadataPath = resolve(root, GUARD_BASELINE_META_FILE);
    const previous = readJson(metadataPath);
    const history =
      previous !== null &&
      typeof previous === 'object' &&
      Array.isArray((previous as { decisions?: unknown }).decisions)
        ? (previous as { decisions: unknown[] }).decisions
        : [];
    const decision = {
      at: new Date().toISOString(),
      action: (options.add?.length ?? 0) > 0 ? 'accept' : 'remove',
      fingerprints: [...(options.add ?? []), ...(options.remove ?? [])],
      ...(options.reason?.trim() ? { reason: options.reason.trim() } : {}),
    };
    atomicWriteFile(
      resolve(root, GUARD_BASELINE_FILE),
      `${JSON.stringify(fingerprints, null, 2)}\n`,
    );
    atomicWriteFile(
      metadataPath,
      `${JSON.stringify(
        {
          ...(previous !== null && typeof previous === 'object' ? previous : {}),
          version: 1,
          generatedAt: new Date().toISOString(),
          findings: fingerprints.length,
          decisions: [...history, decision],
        },
        null,
        2,
      )}\n`,
    );
    return next;
  });
}

export function writeGuardConfig(
  root: string,
  guardConfig: GuardConfig,
  options: GuardConfigWriteOptions = {},
): void {
  withGuardStateLock(
    root,
    () => {
      mkdirSync(resolve(root, GUARD_DIR), { recursive: true });
      const current = loadGuardConfig(root);
      const currentRevision = current?.revision ?? 0;
      const expectedRevision = options.expectedRevision ?? guardConfig.revision;
      if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
        throw new GuardStateStaleError();
      }
      const nextRevision = currentRevision + 1;
      const contentFingerprint = fingerprintGuardConfig(guardConfig);
      const { contracts = [], ...rulesConfig } = guardConfig;
      atomicWriteFile(
        resolve(root, GUARD_RULES_FILE),
        `${JSON.stringify({ ...rulesConfig, revision: nextRevision, contentFingerprint }, null, 2)}\n`,
      );
      atomicWriteFile(
        resolve(root, GUARD_CONTRACTS_FILE),
        `${JSON.stringify({ version: 1, contracts }, null, 2)}\n`,
      );
    },
    options,
  );
}

export function writeGuardProposals(root: string, proposals: GuardProposalFile): void {
  writeGuardArtifact(root, GUARD_PROPOSALS_FILE, proposals);
}

export function recordGuardProposalDecision(
  root: string,
  decisions: Pick<GuardProposalDecision, 'id' | 'type' | 'decision'>[],
  options: Pick<GuardProposalDecision, 'source'> = { source: 'external' },
): void {
  withGuardStateLock(root, () => {
    const proposals = loadGuardProposals(root);
    if (!proposals || decisions.length === 0) return;
    const decidedAt = new Date().toISOString();
    const commit = (() => {
      try {
        return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, stdio: 'pipe' })
          .toString()
          .trim();
      } catch {
        return undefined;
      }
    })();
    const nextDecisions = decisions.map((decision) => ({
      ...decision,
      decidedAt,
      source: options.source,
      ...(process.env.GUARD_APPROVER?.trim() ? { actor: process.env.GUARD_APPROVER.trim() } : {}),
      ...(commit ? { commit } : {}),
      ...(proposals.proposalId ? { proposalId: proposals.proposalId } : {}),
      ...(proposals.contentFingerprint
        ? { proposalFingerprint: proposals.contentFingerprint }
        : {}),
      ...(typeof proposals.revision === 'number' ? { revision: proposals.revision } : {}),
    }));
    writeGuardProposals(root, {
      ...proposals,
      decisions: [...(proposals.decisions ?? []), ...nextDecisions],
    });
  });
}

export function getPendingGuardProposals(
  proposals: GuardProposalFile | undefined,
): GuardPendingProposal[] {
  if (!proposals) return [];
  const decisions = new Map<string, GuardProposalDecision>();
  for (const decision of proposals.decisions ?? []) {
    const current = decisions.get(`${decision.type}:${decision.id}`);
    if (!current || decision.decidedAt >= current.decidedAt) {
      decisions.set(`${decision.type}:${decision.id}`, decision);
    }
  }
  const matchesCurrentProposal = (decision: GuardProposalDecision | undefined): boolean =>
    decision !== undefined &&
    (proposals.proposalId === undefined || decision.proposalId === proposals.proposalId) &&
    (proposals.contentFingerprint === undefined ||
      decision.proposalFingerprint === proposals.contentFingerprint) &&
    (proposals.revision === undefined || decision.revision === proposals.revision);
  return [
    ...proposals.rules
      .filter(
        (rule) =>
          rule.status === 'proposed' && !matchesCurrentProposal(decisions.get(`rule:${rule.id}`)),
      )
      .map((rule) => ({ id: rule.id, type: 'rule' as const })),
    ...proposals.contracts
      .filter(
        (contract) =>
          contract.status === 'proposed' &&
          !matchesCurrentProposal(decisions.get(`contract:${contract.id}`)),
      )
      .map((contract) => ({ id: contract.id, type: 'contract' as const })),
  ];
}

export function buildGuardProposals(
  model: ProjectModel,
  guardConfig: GuardConfig,
): GuardProposalFile {
  const capabilities = Object.keys(model.capabilities);
  const questions: string[] = [];
  const observedContracts: GuardContract[] = [];
  if (capabilities.includes('identity')) {
    observedContracts.push({
      id: 'canonical-auth-entrypoint',
      statement:
        'Protected server operations must use the project authentication entrypoint before accessing protected data.',
      guidance: [
        'Use the observed authentication service instead of reading session storage directly.',
      ],
      references: model.modules
        .map((module) => module.path)
        .filter((path) => /(?:^|\/)(?:auth|authentication|identity|session)(?:\/|\.|$)/i.test(path))
        .slice(0, 5),
      status: 'proposed',
      confidence: 'medium',
      evidence: model.capabilities.identity.evidence,
    });
  }
  if (capabilities.includes('persistence')) {
    observedContracts.push({
      id: 'persistence-boundary',
      statement:
        'Application-facing code should use the observed persistence boundary instead of scattering database access.',
      guidance: ['Prefer the observed repository or service modules for database access.'],
      references: model.files
        .filter(
          (file) =>
            file.kind === 'schema' ||
            /(?:^|\/)(?:db|database|repositories)(?:\/|$)/i.test(file.path),
        )
        .map((file) => file.path)
        .slice(0, 5),
      status: 'proposed',
      confidence: 'low',
      evidence: model.capabilities.persistence.evidence,
    });
  }
  if (capabilities.includes('identity')) {
    questions.push(
      'Which authentication and organization-authorization entrypoints are canonical?',
    );
  }
  if (capabilities.includes('payments')) {
    questions.push('Which billing adapter owns checkout, webhook, and idempotency behavior?');
  }
  if (capabilities.includes('persistence')) {
    questions.push('Which modules are allowed to access the database directly?');
  }
  const proposal = {
    version: 1 as const,
    generatedAt: new Date().toISOString(),
    rules: guardConfig.rules.filter((rule) => rule.status === 'proposed'),
    contracts: [
      ...(guardConfig.contracts ?? []).filter((contract) => contract.status === 'proposed'),
      ...observedContracts.filter(
        (observedContract) =>
          !(guardConfig.contracts ?? []).some((contract) => contract.id === observedContract.id),
      ),
    ],
    questions,
  };
  const projectFingerprint = fingerprintProjectModel(model);
  const contentFingerprint = createHash('sha256')
    .update(JSON.stringify({ rules: proposal.rules, contracts: proposal.contracts, questions }))
    .digest('hex');
  return {
    ...proposal,
    projectFingerprint,
    revision: 1,
    contentFingerprint,
    proposalId: createHash('sha256')
      .update(JSON.stringify({ projectFingerprint, ...proposal, generatedAt: undefined }))
      .digest('hex')
      .slice(0, 16),
  };
}

export function buildArchitectureMemory(model: ProjectModel): Record<string, unknown> {
  const persistencePackages = Object.keys({
    ...model.project.dependencies,
    ...model.project.devDependencies,
  }).filter((name) =>
    [
      'drizzle-orm',
      'prisma',
      '@prisma/client',
      'typeorm',
      'sequelize',
      'mongoose',
      'knex',
    ].includes(name),
  );
  return {
    version: 1,
    generatedBy: 'codapult-guard init',
    frameworks: model.project.frameworks,
    workspacePackages: model.project.workspacePackages,
    capabilities: model.capabilities,
    map: {
      layers: model.insights.layers,
      edges: model.insights.layerEdges,
    },
    dependencyGraph: {
      edges: model.insights.dependencyEdges,
    },
    layers: model.insights.layers,
    boundaries: model.insights.boundaries,
    persistence: {
      packages: persistencePackages,
      schemaFiles: model.schemas,
    },
    authorization: {
      implementationModules: model.modules
        .filter((module) => /(?:^|\/)(?:auth|authentication)(?:\/|\.|$)/i.test(module.path))
        .map((module) => module.path),
    },
    billing: {
      providerCandidates: Object.keys({
        ...model.project.dependencies,
        ...model.project.devDependencies,
      }).filter((name) => /stripe|lemonsqueezy|paddle|paypal|braintree/i.test(name)),
    },
    routes: model.patterns.routeDetails,
    environment: {
      references: model.insights.envReferences,
    },
    cycles: model.insights.cycles,
    packs: detectGuardPacks(model).map((pack) => ({
      id: pack.id,
      title: pack.title,
      focus: pack.focus,
    })),
    packAssessments: assessGuardPacks(model),
  };
}

export function buildConventionsMemory(model: ProjectModel): Record<string, unknown> {
  const directives = [...new Set(model.modules.flatMap((module) => module.directives))].sort();
  const sourceExtensions = [
    ...new Set(
      model.files.filter((file) => file.kind === 'source').map((file) => extname(file.path)),
    ),
  ].sort();
  return {
    version: 1,
    generatedBy: 'codapult-guard init',
    packageManager: model.project.packageManager,
    scripts: model.tests.scripts,
    configFiles: model.configs,
    testFiles: model.tests.files,
    sourceExtensions,
    directives,
    routeHandlers: model.patterns.routeHandlers,
    barrelFiles: model.patterns.barrelFiles,
  };
}

export function buildGeneratedGuardConfig(model: ProjectModel): GuardConfig {
  const isPersistenceImport = (importPath: string): boolean =>
    /(?:^|\/)(?:database|db)(?:\/|$)/i.test(importPath) ||
    /^(?:@prisma\/client|prisma|drizzle-orm|drizzle-kit|typeorm|sequelize|mongoose|knex)(?:\/|$)/i.test(
      importPath,
    );
  const moduleReferences = (module: ProjectModel['modules'][number]): string[] => [
    ...module.imports,
    ...module.exports,
    ...module.dynamicImports,
  ];
  const persistenceImports = [
    ...new Set(
      model.modules.flatMap((module) => moduleReferences(module)).filter(isPersistenceImport),
    ),
  ].sort();
  const clientPersistenceFiles =
    model.insights.boundaries
      .find((boundary) => boundary.kind === 'client')
      ?.files.filter((file) =>
        model.modules.some(
          (module) =>
            module.path === file &&
            moduleReferences(module).some((importPath) => persistenceImports.includes(importPath)),
        ),
      ) ?? [];
  const proposedRules: GuardRule[] =
    clientPersistenceFiles.length > 0
      ? [
          {
            id: 'client-no-persistence-import',
            description: 'Client modules should not import persistence-layer modules.',
            severity: 'error',
            kind: 'client-forbidden-import',
            patterns: persistenceImports,
            status: 'proposed',
            confidence: 'medium',
            evidence: clientPersistenceFiles,
          },
        ]
      : [];
  return { ...defaultGuardConfig, rules: proposedRules };
}

export function writeGuardMemory(root: string, model: ProjectModel): void {
  withGuardStateLock(root, () => {
    writeGuardArtifact(root, GUARD_ARCHITECTURE_FILE, buildArchitectureMemory(model));
    writeGuardArtifact(root, GUARD_CONVENTIONS_FILE, buildConventionsMemory(model));
  });
}

export function writeBaseline(root: string, findings: GuardFinding[], model?: ProjectModel): void {
  withGuardStateLock(root, () => {
    mkdirSync(resolve(root, GUARD_DIR), { recursive: true });
    const fingerprints = [...new Set(findings.map((finding) => finding.fingerprint))].sort();
    atomicWriteFile(
      resolve(root, GUARD_BASELINE_FILE),
      `${JSON.stringify(fingerprints, null, 2)}\n`,
    );
    atomicWriteFile(
      resolve(root, GUARD_BASELINE_META_FILE),
      `${JSON.stringify(
        {
          version: 1,
          generatedAt: new Date().toISOString(),
          findings: fingerprints.length,
          ...(model ? { projectFingerprint: fingerprintProjectModel(model) } : {}),
          guardSchemaVersion: 1,
          purpose: 'Initial Guard state; findings are suppressed unless they change fingerprint.',
        },
        null,
        2,
      )}\n`,
    );
  });
}

export function loadProjectModel(root: string): ProjectModel | undefined {
  const current = readJson(resolve(root, GUARD_STATE_CURRENT_FILE));
  if (
    current !== undefined &&
    typeof current === 'object' &&
    safeGeneration((current as { generation?: unknown }).generation)
  ) {
    const generated = readJson(
      resolve(
        root,
        GUARD_STATE_GENERATIONS_DIR,
        (current as { generation: string }).generation,
        'project.json',
      ),
    );
    if (
      generated !== undefined &&
      typeof generated === 'object' &&
      (generated as { version?: unknown }).version === 1
    )
      return generated as ProjectModel;
  }
  const value = readJson(resolve(root, GUARD_PROJECT_FILE));
  if (
    value === null ||
    typeof value !== 'object' ||
    (value as { version?: unknown }).version !== 1
  ) {
    return undefined;
  }
  return value as ProjectModel;
}

export function writeProjectModel(root: string, model: ProjectModel): void {
  withGuardStateLock(root, () => {
    mkdirSync(resolve(root, GUARD_DIR), { recursive: true });
    atomicWriteFile(resolve(root, GUARD_PROJECT_FILE), `${JSON.stringify(model, null, 2)}\n`);
  });
}

/**
 * Persist all derived project facts as one generation. Legacy root-level files remain as
 * compatibility mirrors, while readers that understand generations always see a coherent set.
 */
export function writeProjectState(
  root: string,
  model: ProjectModel,
  options: GuardStateLockOptions = {},
): string {
  return withGuardStateLock(
    root,
    () => {
      const generationsRoot = resolve(root, GUARD_STATE_GENERATIONS_DIR);
      mkdirSync(generationsRoot, { recursive: true });
      const generation = `${Date.now()}-${randomUUID()}`;
      const temporaryRoot = resolve(generationsRoot, `.tmp-${process.pid}-${randomUUID()}`);
      mkdirSync(temporaryRoot, { recursive: true });
      const derived = {
        project: model,
        architecture: buildArchitectureMemory(model),
        conventions: buildConventionsMemory(model),
      };
      for (const [name, value] of Object.entries(derived)) {
        writeFileSync(
          resolve(temporaryRoot, `${name}.json`),
          `${JSON.stringify(value, null, 2)}\n`,
        );
      }
      writeFileSync(
        resolve(temporaryRoot, 'manifest.json'),
        `${JSON.stringify({ version: 1, generation, projectFingerprint: fingerprintProjectModel(model) }, null, 2)}\n`,
      );
      renameSync(temporaryRoot, resolve(generationsRoot, generation));
      atomicWriteFile(
        resolve(root, GUARD_STATE_CURRENT_FILE),
        `${JSON.stringify({ version: 1, generation, projectFingerprint: fingerprintProjectModel(model) }, null, 2)}\n`,
      );
      atomicWriteFile(resolve(root, GUARD_PROJECT_FILE), `${JSON.stringify(model, null, 2)}\n`);
      atomicWriteFile(
        resolve(root, GUARD_ARCHITECTURE_FILE),
        `${JSON.stringify(derived.architecture, null, 2)}\n`,
      );
      atomicWriteFile(
        resolve(root, GUARD_CONVENTIONS_FILE),
        `${JSON.stringify(derived.conventions, null, 2)}\n`,
      );
      // Snapshot persistence is defined below the generation writer to keep the public API grouped.
      // eslint-disable-next-line @typescript-eslint/no-use-before-define
      return writeProjectSnapshot(root, model);
    },
    options,
  );
}

function projectRevision(root: string): string {
  try {
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, stdio: 'pipe' })
      .toString()
      .trim();
    return revision || 'working-tree';
  } catch {
    return 'working-tree';
  }
}

export function writeProjectSnapshot(root: string, model: ProjectModel): string {
  return withGuardStateLock(root, () => {
    const baseRevision = projectRevision(root);
    const revision =
      model.git.dirty && baseRevision !== 'working-tree'
        ? `${baseRevision}-working-tree-${createHash('sha256')
            .update(JSON.stringify(model))
            .digest('hex')
            .slice(0, 12)}`
        : baseRevision;
    mkdirSync(resolve(root, GUARD_HISTORY_DIR), { recursive: true });
    atomicWriteFile(
      resolve(root, GUARD_HISTORY_DIR, `${revision}.json`),
      `${JSON.stringify(model, null, 2)}\n`,
    );
    return revision;
  });
}

function isProjectPath(root: string, value: string): boolean {
  const normalized = value.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    return false;
  }
  try {
    const projectRoot = `${realpathSync(root)}${sep}`;
    const targetPath = resolve(root, normalized);
    let target: string;
    try {
      target = realpathSync(targetPath);
    } catch {
      target = realpathSync(dirname(targetPath));
    }
    return target === projectRoot.slice(0, -1) || target.startsWith(projectRoot);
  } catch {
    return false;
  }
}

export function loadGuardArtifact(root: string, relativePath: string): unknown {
  if (!isProjectPath(root, relativePath)) return undefined;
  const generatedName =
    relativePath === GUARD_PROJECT_FILE
      ? 'project.json'
      : relativePath === GUARD_ARCHITECTURE_FILE
        ? 'architecture.json'
        : relativePath === GUARD_CONVENTIONS_FILE
          ? 'conventions.json'
          : undefined;
  if (generatedName) {
    const current = readJson(resolve(root, GUARD_STATE_CURRENT_FILE));
    if (
      current !== undefined &&
      typeof current === 'object' &&
      safeGeneration((current as { generation?: unknown }).generation)
    ) {
      const generated = readJson(
        resolve(
          root,
          GUARD_STATE_GENERATIONS_DIR,
          (current as { generation: string }).generation,
          generatedName,
        ),
      );
      if (generated !== undefined) return generated;
    }
  }
  return readJson(resolve(root, relativePath));
}

export function validateGuardContracts(
  root: string,
  contracts: GuardContract[] = [],
): GuardContractIssue[] {
  const issues: GuardContractIssue[] = [];
  for (const contract of contracts) {
    if (
      contract.kind === 'import-boundary' &&
      (contract.mustImport?.length ?? 0) === 0 &&
      (contract.mustNotImport?.length ?? 0) === 0
    ) {
      issues.push({
        contractId: contract.id,
        field: 'definition',
        value: contract.kind,
        message: 'Import-boundary contracts need mustImport or mustNotImport patterns.',
      });
    }
    if (contract.kind === 'required-call' && (contract.mustCall?.length ?? 0) === 0) {
      issues.push({
        contractId: contract.id,
        field: 'definition',
        value: contract.kind,
        message: 'Required-call contracts need at least one mustCall pattern.',
      });
    }
    if (
      contract.kind === 'package-boundary' &&
      ((contract.fromPackages?.length ?? 0) === 0 ||
        (contract.mustNotImportPackages?.length ?? 0) === 0)
    ) {
      issues.push({
        contractId: contract.id,
        field: 'definition',
        value: contract.kind,
        message: 'Package-boundary contracts need fromPackages and mustNotImportPackages patterns.',
      });
    }
    for (const scope of contract.scope ?? []) {
      if (!isProjectPath(root, scope) || !existsSync(resolve(root, scope))) {
        issues.push({
          contractId: contract.id,
          field: 'scope',
          value: scope,
          message: `Contract scope does not exist: ${scope}`,
        });
      }
    }
    for (const entrypoint of contract.entrypoints ?? []) {
      if (!isProjectPath(root, entrypoint) || !existsSync(resolve(root, entrypoint))) {
        issues.push({
          contractId: contract.id,
          field: 'scope',
          value: entrypoint,
          message: `Contract entrypoint does not exist: ${entrypoint}`,
        });
      }
    }
    for (const excluded of contract.exclude ?? []) {
      if (!isProjectPath(root, excluded) || !existsSync(resolve(root, excluded))) {
        issues.push({
          contractId: contract.id,
          field: 'scope',
          value: excluded,
          message: `Contract exclusion does not exist: ${excluded}`,
        });
      }
    }
    for (const reference of contract.references ?? []) {
      if (!isProjectPath(root, reference) || !existsSync(resolve(root, reference))) {
        issues.push({
          contractId: contract.id,
          field: 'reference',
          value: reference,
          message: `Contract reference does not exist: ${reference}`,
        });
      }
    }
  }
  return issues;
}

function isSourceFile(file: string): boolean {
  return /\.(?:ts|tsx|js|jsx)$/.test(file) && !/\.(?:test|spec)\.(?:ts|tsx|js|jsx)$/.test(file);
}

function listSourceFiles(root: string, directory = root): string[] {
  const ignored = new Set(['.git', '.next', 'dist', 'node_modules', GUARD_DIR.split('/')[0]]);
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const fullPath = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...listSourceFiles(root, fullPath));
    else if (entry.isFile() && isSourceFile(entry.name)) files.push(relative(root, fullPath));
  }
  return files.sort();
}

function patternMatches(importPath: string, pattern: string): boolean {
  return pattern.endsWith('*')
    ? importPath.startsWith(pattern.slice(0, -1))
    : importPath === pattern || importPath.startsWith(`${pattern}/`);
}

function ruleAppliesToFile(rule: GuardRule, file: string): boolean {
  return (
    !rule.files || rule.files.some((prefix) => file === prefix || file.startsWith(`${prefix}/`))
  );
}

function contractAppliesToFile(contract: GuardContract, file: string): boolean {
  const matches = (patterns: string[]): boolean =>
    patterns.some((pattern) =>
      pattern.endsWith('*')
        ? file.startsWith(pattern.slice(0, -1))
        : file === pattern || file.startsWith(`${pattern}/`),
    );
  const includedByScope = !contract.scope || matches(contract.scope);
  const includedByEntrypoint = !contract.entrypoints || matches(contract.entrypoints);
  const excluded = contract.exclude !== undefined && matches(contract.exclude);
  return includedByScope && includedByEntrypoint && !excluded;
}

function importLine(sourceFile: SourceFile, importPath: string): number {
  const declaration = sourceFile
    .getImportDeclarations()
    .find((item) => item.getModuleSpecifierValue() === importPath);
  if (declaration) return declaration.getStartLineNumber();
  const exportDeclaration = sourceFile
    .getExportDeclarations()
    .find((item) => item.getModuleSpecifierValue() === importPath);
  if (exportDeclaration) return exportDeclaration.getStartLineNumber();
  const dynamicImport = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression).find((item) => {
    if (item.getExpression().getText() !== 'import') return false;
    const argument = item.getArguments()[0];
    return argument.isKind(SyntaxKind.StringLiteral) && argument.getLiteralValue() === importPath;
  });
  return dynamicImport?.getStartLineNumber() ?? 1;
}

interface ModuleImportReference {
  source: string;
  resolved?: string | undefined;
}

function moduleImportReferences(module: ProjectModel['modules'][number]): ModuleImportReference[] {
  const sources = [...new Set([...module.imports, ...module.exports, ...module.dynamicImports])];
  return sources.map((source) => ({ source, resolved: module.resolvedImportMap?.[source] }));
}

function packageSelectorMatches(value: string | undefined, selector: string): boolean {
  if (!value) return false;
  return selector.endsWith('*') ? value.startsWith(selector.slice(0, -1)) : value === selector;
}

function packageForFile(model: ProjectModel, file: string): string | undefined {
  const packageInfo =
    model.project.workspacePackages
      .filter(
        (workspace) =>
          workspace.path === '.' ||
          file === `${workspace.path}/package.json` ||
          file.startsWith(`${workspace.path}/`),
      )
      .sort((left, right) => right.path.length - left.path.length)[0] ?? null;
  return packageInfo === null ? undefined : (packageInfo.name ?? packageInfo.path);
}

function packageForImport(
  model: ProjectModel,
  reference: ModuleImportReference,
): string | undefined {
  const resolvedPackage = reference.resolved
    ? packageForFile(model, reference.resolved)
    : undefined;
  if (resolvedPackage) return resolvedPackage;
  return model.project.workspacePackages.find(
    (workspace) =>
      workspace.name === reference.source ||
      (workspace.name !== undefined && reference.source.startsWith(`${workspace.name}/`)),
  )?.name;
}

function scanFile(
  root: string,
  file: string,
  rules: GuardRule[],
  module: ProjectModel['modules'][number] | undefined,
  astProject: Project,
): GuardFinding[] {
  if (!module) return [];
  const isClient = module.directives.includes('use client');
  let sourceFile = astProject.getSourceFile(resolve(root, file));
  if (!sourceFile) {
    try {
      sourceFile = astProject.addSourceFileAtPath(resolve(root, file));
    } catch {
      sourceFile = undefined;
    }
  }
  const findings: GuardFinding[] = [];
  for (const reference of moduleImportReferences(module)) {
    const line = sourceFile ? importLine(sourceFile, reference.source) : 1;
    for (const rule of rules) {
      if (rule.status === 'proposed' || !ruleAppliesToFile(rule, file)) continue;
      if (rule.kind === 'client-forbidden-import' && !isClient) continue;
      if (
        !rule.patterns.some(
          (pattern) =>
            patternMatches(reference.source, pattern) ||
            (reference.resolved !== undefined && patternMatches(reference.resolved, pattern)),
        )
      )
        continue;
      findings.push({
        ruleId: rule.id,
        severity: rule.severity,
        file,
        line,
        importPath: reference.source,
        ...(reference.resolved ? { resolvedPath: reference.resolved } : {}),
        message: rule.description,
        fingerprint: `${rule.id}|${file}|${reference.source}|${reference.resolved ?? ''}`,
      });
    }
  }
  return findings;
}

function scanContracts(
  root: string,
  contracts: GuardContract[],
  changed?: Set<string>,
): GuardFinding[] {
  const model = discoverProject(root);
  const findings: GuardFinding[] = [];
  for (const contract of contracts) {
    if (contract.status === 'proposed' || !contract.kind || contract.kind === 'guidance') continue;
    const severity = contract.severity ?? 'error';
    for (const module of model.modules.filter(
      (item) => (!changed || changed.has(item.path)) && contractAppliesToFile(contract, item.path),
    )) {
      if (contract.kind === 'import-boundary') {
        for (const reference of moduleImportReferences(module)) {
          if (
            contract.mustNotImport?.some(
              (pattern) =>
                patternMatches(reference.source, pattern) ||
                (reference.resolved !== undefined && patternMatches(reference.resolved, pattern)),
            )
          ) {
            findings.push({
              ruleId: `contract:${contract.id}`,
              severity,
              file: module.path,
              line: 1,
              importPath: reference.source,
              ...(reference.resolved ? { resolvedPath: reference.resolved } : {}),
              message: contract.statement,
              fingerprint: `contract-import|${contract.id}|${module.path}|${reference.source}|${reference.resolved ?? ''}`,
            });
          }
        }
        if (
          contract.mustImport !== undefined &&
          contract.mustImport.length > 0 &&
          !moduleImportReferences(module).some((reference) =>
            contract.mustImport?.some(
              (pattern) =>
                patternMatches(reference.source, pattern) ||
                (reference.resolved !== undefined && patternMatches(reference.resolved, pattern)),
            ),
          )
        ) {
          findings.push({
            ruleId: `contract:${contract.id}`,
            severity,
            file: module.path,
            line: 1,
            importPath: 'contract',
            message: contract.statement,
            fingerprint: `contract-required-import|${contract.id}|${module.path}`,
          });
        }
      }
      if (
        contract.kind === 'required-call' &&
        contract.mustCall !== undefined &&
        contract.mustCall.length > 0 &&
        !module.calls.some((call) =>
          contract.mustCall?.some((required) => call === required || call.endsWith(`.${required}`)),
        )
      ) {
        findings.push({
          ruleId: `contract:${contract.id}`,
          severity,
          file: module.path,
          line: 1,
          importPath: 'contract',
          message: contract.statement,
          fingerprint: `contract-required-call|${contract.id}|${module.path}`,
        });
      }
      if (contract.kind === 'package-boundary') {
        const sourcePackage = packageForFile(model, module.path);
        if (
          !contract.fromPackages?.some((selector) =>
            packageSelectorMatches(sourcePackage, selector),
          )
        ) {
          continue;
        }
        for (const reference of moduleImportReferences(module)) {
          const targetPackage = packageForImport(model, reference);
          if (
            !contract.mustNotImportPackages?.some((selector) =>
              packageSelectorMatches(targetPackage, selector),
            )
          ) {
            continue;
          }
          findings.push({
            ruleId: `contract:${contract.id}`,
            severity,
            file: module.path,
            line: 1,
            importPath: reference.source,
            ...(reference.resolved ? { resolvedPath: reference.resolved } : {}),
            message: contract.statement,
            fingerprint: `contract-package|${contract.id}|${module.path}|${reference.source}|${targetPackage ?? ''}`,
          });
        }
      }
    }
  }
  return findings;
}

function changedFiles(root: string): Set<string> | undefined {
  try {
    const changed = execFileSync('git', ['diff', '--name-only', 'HEAD'], {
      cwd: root,
      stdio: 'pipe',
    })
      .toString()
      .trim();
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd: root,
      stdio: 'pipe',
    })
      .toString()
      .trim();
    return new Set([
      ...(changed ? changed.split('\n') : []),
      ...(untracked ? untracked.split('\n') : []),
    ]);
  } catch {
    return undefined;
  }
}

function changedImpactScope(
  model: ProjectModel,
  changed: Set<string> | undefined,
): Set<string> | undefined {
  if (!changed) return undefined;
  const graph = buildModuleTargetGraph(model.modules);
  const reverse = new Map<string, string[]>();
  for (const [from, targets] of graph) {
    for (const target of targets) reverse.set(target, [...(reverse.get(target) ?? []), from]);
  }
  const scope = new Set(changed);
  const queue = [...changed];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    for (const dependent of reverse.get(current) ?? []) {
      if (!scope.has(dependent)) {
        scope.add(dependent);
        queue.push(dependent);
      }
    }
  }
  return scope;
}

function architectureInsightFindings(
  root: string,
  changed: Set<string> | undefined,
): GuardFinding[] {
  const model = discoverProject(root);
  const findings: GuardFinding[] = model.insights.cycles
    .filter((cycle) => !changed || cycle.some((file) => changed.has(file)))
    .map((cycle) => ({
      ruleId: 'architecture-cycle',
      severity: 'warning' as const,
      file: cycle[0] ?? 'project',
      line: 1,
      importPath: 'architecture',
      message: `Circular dependency detected: ${cycle.join(' -> ')}`,
      fingerprint: `architecture-cycle|${cycle.join('|')}`,
    }));
  const clientFiles = new Set(
    model.insights.boundaries
      .filter((boundary) => boundary.kind === 'client')
      .flatMap((boundary) => boundary.files),
  );
  const serverOnlyImports =
    /^(?:server-only|next\/(?:headers|cookies|server|cache)|node:fs|fs|node:child_process|child_process)(?:\/|$)/;
  for (const module of model.modules) {
    if (!clientFiles.has(module.path)) continue;
    for (const importPath of [
      ...new Set([...module.imports, ...module.exports, ...module.dynamicImports]),
    ].filter((value) => serverOnlyImports.test(value))) {
      if (changed && !changed.has(module.path)) continue;
      findings.push({
        ruleId: 'client-server-boundary',
        severity: 'error',
        file: module.path,
        line: 1,
        importPath,
        message: 'Client modules must not import server-only modules.',
        fingerprint: `client-server-boundary|${module.path}|${importPath}`,
      });
    }
  }
  for (const reference of model.insights.envReferences) {
    if (reference.declared) continue;
    const file = reference.files.find((value) => !changed || changed.has(value));
    if (!file) continue;
    findings.push({
      ruleId: 'undeclared-environment-reference',
      severity: 'warning',
      file,
      line: 1,
      importPath: `env:${reference.name}`,
      message: `Environment variable ${reference.name} is not declared in .env.example.`,
      fingerprint: `undeclared-environment-reference|${reference.name}|${file}`,
    });
  }
  return findings;
}

function budgetMatchesFile(budget: GuardBudget, file: string): boolean {
  return budget.scope.some((scope) =>
    scope.endsWith('*')
      ? file.startsWith(scope.slice(0, -1))
      : file === scope || file.startsWith(`${scope}/`),
  );
}

function budgetValue(
  root: string,
  metric: GuardBudgetMetric,
  file: ProjectModel['files'][number],
  module: ProjectModel['modules'][number] | undefined,
): number {
  if (metric === 'bytes') return file.bytes;
  if (metric === 'imports') {
    return module
      ? new Set([...module.imports, ...module.exports, ...module.dynamicImports]).size
      : 0;
  }
  try {
    return readFileSync(resolve(root, file.path), 'utf8').split(/\r?\n/).length;
  } catch {
    return 0;
  }
}

function scanBudgets(
  root: string,
  model: ProjectModel,
  budgets: GuardBudget[],
  changed?: Set<string>,
): GuardFinding[] {
  const modules = new Map(model.modules.map((module) => [module.path, module]));
  return budgets
    .filter((budget) => budget.status !== 'proposed')
    .flatMap((budget) =>
      model.files
        .filter(
          (file) =>
            file.kind === 'source' &&
            budgetMatchesFile(budget, file.path) &&
            (!changed || changed.has(file.path)),
        )
        .flatMap((file) => {
          const value = budgetValue(root, budget.metric, file, modules.get(file.path));
          if (value <= budget.limit) return [];
          return [
            {
              ruleId: `budget:${budget.id}`,
              severity: budget.severity,
              file: file.path,
              line: 1,
              importPath: `budget:${budget.metric}`,
              message: `${budget.description} (${value} ${budget.metric}; limit ${budget.limit}).`,
              fingerprint: `budget|${budget.id}|${file.path}|${budget.metric}`,
            },
          ];
        }),
    );
}

function isSafeReviewFile(file: string): boolean {
  return !(
    file === '.env' ||
    file.startsWith('.env.') ||
    /(?:credentials|secrets?)/i.test(file) ||
    /\.(?:pem|key|p12|pfx)$/i.test(file)
  );
}

function isSafeReviewPath(root: string, file: string): boolean {
  return isProjectPath(root, file);
}

function parseGitChanges(root: string, args: string[]): GuardFileChange[] {
  try {
    return execFileSync('git', ['diff', '--name-status', '-M', ...args], {
      cwd: root,
      stdio: 'pipe',
    })
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean)
      .flatMap((line): GuardFileChange[] => {
        const [rawStatus, first, second] = line.split('\t');
        if (!rawStatus || !first || !isSafeReviewFile(first) || !isSafeReviewPath(root, first)) {
          return [];
        }
        const status = rawStatus[0];
        if (status === 'R') {
          if (!second || !isSafeReviewFile(second) || !isSafeReviewPath(root, second)) return [];
          return [{ path: second, previousPath: first, status: 'renamed' as const }];
        }
        const mapped: GuardFileChange['status'] =
          status === 'A' ? 'added' : status === 'D' ? 'deleted' : 'modified';
        return [{ path: first, status: mapped }];
      });
  } catch {
    return [];
  }
}

/** @internal Redacts common credential shapes before a diff enters an AI review packet. */
export function redactSensitiveText(value: string): GuardSensitiveText {
  let redacted = false;
  let redactionCount = 0;
  let redactedValue = value;
  const replace = (pattern: RegExp, replacement: string): void => {
    const next = redactedValue.replace(pattern, replacement);
    if (next !== redactedValue) {
      redacted = true;
      redactionCount += (redactedValue.match(pattern) ?? []).length;
    }
    redactedValue = next;
  };
  replace(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, '[REDACTED PRIVATE KEY]');
  replace(
    /\b(?:sk_(?:live|test)_|pk_(?:live|test)_|AKIA|gh[pousr]_|github_pat_)[A-Za-z0-9_-]+/g,
    '[REDACTED TOKEN]',
  );
  replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED JWT]');
  replace(/\bhttps?:\/\/[^\s/@:]+:[^\s/@]+@/gi, '[REDACTED URL CREDENTIALS]@');
  replace(/\b(?:AIza[0-9A-Za-z_-]{20,}|xox[baprs]-[0-9A-Za-z-]{10,})\b/g, '[REDACTED TOKEN]');
  replace(
    /((?:api[_-]?key|secret|token|password|authorization|database[_-]?url)\s*[:=]\s*["']?)[^\s"'`,}]+/gi,
    '$1[REDACTED]',
  );
  return { value: redactedValue, redacted, redactionCount };
}

function isSafeGitRevision(value: string): boolean {
  return (
    value.length > 0 && value.length <= 256 && !value.startsWith('-') && /^[\w./@-]+$/.test(value)
  );
}

function reviewDiff(root: string, maxChars: number, base?: string): GuardReviewDiff {
  try {
    if (base !== undefined && !isSafeGitRevision(base)) {
      return {
        diff: '',
        truncated: false,
        redacted: false,
        changedFiles: [],
        changes: [],
        error: `Unsafe Git base ref rejected: ${base}`,
      };
    }
    const diffArgs = base
      ? ['diff', '--name-only', `${base}...HEAD`]
      : ['diff', '--name-only', 'HEAD'];
    const contentDiffArgs = base
      ? ['diff', '--no-ext-diff', '--unified=80', `${base}...HEAD`]
      : ['diff', '--no-ext-diff', '--unified=80', 'HEAD'];
    const trackedFiles = execFileSync('git', ['diff', '--name-only', 'HEAD'], {
      cwd: root,
      stdio: 'pipe',
    })
      .toString()
      .trim()
      .split('\n')
      .filter((file) => file.length > 0 && isSafeReviewFile(file) && isSafeReviewPath(root, file));
    const trackedFilesForBase = execFileSync('git', diffArgs, {
      cwd: root,
      stdio: 'pipe',
    })
      .toString()
      .trim()
      .split('\n')
      .filter((file) => file.length > 0 && isSafeReviewFile(file) && isSafeReviewPath(root, file));
    const diffParts: string[] = [];
    if (trackedFilesForBase.length > 0) {
      diffParts.push(
        execFileSync('git', [...contentDiffArgs, '--', ...trackedFilesForBase], {
          cwd: root,
          stdio: 'pipe',
          maxBuffer: Math.max(maxChars * 2, 1_000_000),
        }).toString(),
      );
    }
    if (base && trackedFiles.length > 0) {
      diffParts.push(
        execFileSync(
          'git',
          ['diff', '--no-ext-diff', '--unified=80', 'HEAD', '--', ...trackedFiles],
          {
            cwd: root,
            stdio: 'pipe',
            maxBuffer: Math.max(maxChars * 2, 1_000_000),
          },
        ).toString(),
      );
    }
    const rawDiff = diffParts.join('\n');
    const redactedDiff = redactSensitiveText(rawDiff);
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd: root,
      stdio: 'pipe',
    })
      .toString()
      .trim()
      .split('\n')
      .filter((file) => file.length > 0 && isSafeReviewFile(file) && isSafeReviewPath(root, file));
    const untrackedContent = untracked
      .map((file) => {
        try {
          const content = readFileSync(resolve(root, file), 'utf8');
          const redactedContent = redactSensitiveText(content);
          return `diff --git a/${file} b/${file}\nnew file\n--- /dev/null\n+++ b/${file}\n${redactedContent.value
            .split('\n')
            .map((line) => `+${line}`)
            .join('\n')}`;
        } catch {
          return '';
        }
      })
      .filter((content) => content.length > 0)
      .join('\n');
    const fullDiff = [redactedDiff.value, untrackedContent]
      .filter((part) => part.length > 0)
      .join('\n');
    const redactedUntracked = untracked.some((file) => {
      try {
        return redactSensitiveText(readFileSync(resolve(root, file), 'utf8')).redacted;
      } catch {
        return false;
      }
    });
    return {
      diff: fullDiff.slice(0, maxChars),
      truncated: fullDiff.length > maxChars,
      redacted: redactedDiff.redacted || redactedUntracked,
      changedFiles: [...new Set([...trackedFilesForBase, ...trackedFiles, ...untracked])].sort(),
      changes: [
        ...parseGitChanges(root, base ? [`${base}...HEAD`] : ['HEAD']),
        ...untracked.map((path): GuardFileChange => ({ path, status: 'added' })),
      ].filter(
        (change, index, all) =>
          all.findIndex(
            (candidate) =>
              candidate.path === change.path && candidate.previousPath === change.previousPath,
          ) === index,
      ),
    };
  } catch (error) {
    const detail = error instanceof Error ? ` (${error.message})` : '';
    return {
      diff: '',
      truncated: false,
      redacted: false,
      changedFiles: [],
      changes: [],
      error: base
        ? `Unable to resolve or read Git base ref: ${base}${detail}`
        : `Unable to read Git diff.${detail}`,
    };
  }
}

export function scanGuard(
  root: string,
  guardConfig: GuardConfig,
  options: ScanGuardOptions = {},
): GuardReport {
  const model = discoverProject(root);
  const changed = options.changedOnly ? (options.changedFiles ?? changedFiles(root)) : undefined;
  const scope = changedImpactScope(model, changed);
  const files = listSourceFiles(root).filter((file) => !scope || scope.has(file));
  const modules = new Map(model.modules.map((module) => [module.path, module]));
  const astProject = (() => {
    try {
      return new Project({ tsConfigFilePath: resolve(root, 'tsconfig.json') });
    } catch {
      return new Project({ skipAddingFilesFromTsConfig: true });
    }
  })();
  const allFindings = [
    ...files.flatMap((file) =>
      scanFile(root, file, guardConfig.rules, modules.get(file), astProject),
    ),
    ...scanContracts(root, guardConfig.contracts ?? [], scope),
    ...scanBudgets(root, model, guardConfig.budgets ?? [], scope),
    ...(options.includeArchitectureInsights ? architectureInsightFindings(root, scope) : []),
  ];
  const baseline = options.baseline ?? new Set<string>();
  const findings = allFindings.filter((finding) => !baseline.has(finding.fingerprint));
  return {
    configured: true,
    findings,
    suppressed: allFindings.length - findings.length,
    scannedFiles: files.length,
  };
}

export function buildGuardReviewPacket(
  root: string,
  guardConfig: GuardConfig,
  baseline: Set<string> = new Set<string>(),
  maxDiffChars = 120_000,
  changedOnly = true,
  requirement?: string,
  base?: string,
): GuardReviewPacket {
  const diff = reviewDiff(root, maxDiffChars, base);
  const project = discoverProject(root);
  const report = scanGuard(root, guardConfig, {
    changedOnly,
    changedFiles: changedOnly ? new Set(diff.changedFiles) : undefined,
    baseline,
    includeArchitectureInsights: true,
  });
  const impact = analyzeProjectImpact(project, diff.changedFiles, guardConfig.contracts ?? []);
  return {
    version: 1,
    outcome: classifyGuardOutcome({ errors: diff.error ? 1 : 0, needsReview: !diff.error }),
    ...(base ? { diffBase: base } : {}),
    changedFiles: diff.changedFiles,
    changes: diff.changes,
    diff: diff.diff,
    truncated: diff.truncated,
    redacted: diff.redacted,
    ...(diff.error ? { diffError: diff.error } : {}),
    project,
    contracts: guardConfig.contracts ?? [],
    ...(requirement ? { requirement } : {}),
    deterministicFindings: report.findings,
    impact,
    reviewInstructions: [
      ...(requirement
        ? [
            'Evaluate whether the changed work satisfies the supplied requirement; cite concrete diff evidence and identify uncovered acceptance criteria.',
          ]
        : [
            'No explicit requirement was supplied; infer review scope only from the diff and project context.',
          ]),
      'Review the diff against the project model and contracts.',
      'Treat contracts as project-specific architectural constraints, not generic style rules.',
      'Report only evidence-backed concerns and distinguish violations from recommendations.',
      'Do not repeat findings already reported by deterministic tooling unless the diff changes their impact.',
    ],
  };
}

export function initializeGuard(
  root: string,
  options: GuardConfigWriteOptions & { force?: boolean | undefined } = {},
): GuardInitializationResult {
  return withGuardStateLock(
    root,
    () => {
      if (existsSync(resolve(root, GUARD_BASELINE_FILE)) && !options.force) {
        throw new GuardAlreadyInitializedError();
      }
      const projectModel = discoverProject(root);
      const guardConfig = loadGuardConfig(root) ?? buildGeneratedGuardConfig(projectModel);
      ensureGeneratedStateIgnored(root, projectModel);
      writeGuardConfig(root, guardConfig);
      if (options.force || !existsSync(resolve(root, GUARD_AGENT_FILE))) {
        writeGuardAgentConfig(root);
      }
      writeProjectState(root, projectModel);
      writeGuardProposals(root, buildGuardProposals(projectModel, guardConfig));
      const initialReport = scanGuard(root, guardConfig, { includeArchitectureInsights: true });
      writeBaseline(root, initialReport.findings, projectModel);
      return { config: guardConfig, report: { ...initialReport, findings: [] } };
    },
    options,
  );
}

export { clearDiscoveryCache, discoverProject, discoverProjectWithMetrics, findGuardRoot };
