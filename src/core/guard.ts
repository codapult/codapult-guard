import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { extname, relative, resolve, sep } from 'node:path';
import { Project, SyntaxKind, type SourceFile } from 'ts-morph';
import type { ProjectModel } from './discovery/discovery.js';
import {
  discoverProject,
  discoverProjectWithMetrics,
  findGuardRoot,
} from './discovery/discovery.js';
import { config } from './config.js';
import { assessGuardPacks, detectGuardPacks } from './analysis/packs.js';
import {
  guardAgentConfigSchema,
  guardConfigSchema,
  guardContractsFileSchema,
  guardProposalSchema,
} from './policy/schemas.js';

export type GuardSeverity = 'error' | 'warning' | 'info';
export type GuardOutcomeStatus = 'pass' | 'fail' | 'warning' | 'needs-review' | 'not-configured';

export function classifyGuardOutcome(input: {
  configured?: boolean;
  errors?: number;
  warnings?: number;
  needsReview?: boolean;
}): GuardOutcomeStatus {
  if (input.configured === false) return 'not-configured';
  if ((input.errors ?? 0) > 0) return 'fail';
  if (input.needsReview) return 'needs-review';
  return (input.warnings ?? 0) > 0 ? 'warning' : 'pass';
}
export type GuardRuleKind = 'forbidden-import' | 'client-forbidden-import';
export type GuardRuleStatus = 'active' | 'proposed';
export type GuardContractKind = 'guidance' | 'import-boundary' | 'required-call';

export interface GuardContract {
  id: string;
  statement: string;
  kind?: GuardContractKind;
  severity?: GuardSeverity;
  scope?: string[];
  entrypoints?: string[];
  exclude?: string[];
  guidance?: string[];
  references?: string[];
  mustImport?: string[];
  mustNotImport?: string[];
  mustCall?: string[];
  status?: GuardRuleStatus;
  confidence?: 'high' | 'medium' | 'low';
  evidence?: string[];
}

export interface GuardRule {
  id: string;
  description: string;
  severity: GuardSeverity;
  kind: GuardRuleKind;
  patterns: string[];
  files?: string[];
  status?: GuardRuleStatus;
  confidence?: 'high' | 'medium' | 'low';
  evidence?: string[];
}

export interface GuardConfig {
  version: 1;
  rules: GuardRule[];
  contracts?: GuardContract[];
}

export interface GuardProposalFile {
  version: 1;
  generatedAt: string;
  proposalId?: string;
  projectFingerprint?: string;
  revision?: number;
  contentFingerprint?: string;
  rules: GuardRule[];
  contracts: GuardContract[];
  questions: string[];
  decisions?: GuardProposalDecision[];
}

export interface GuardProposalDecision {
  id: string;
  type: 'rule' | 'contract';
  decision: 'approved' | 'rejected';
  decidedAt: string;
  proposalId?: string;
  proposalFingerprint?: string;
  revision?: number;
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

export type GuardToolMode = 'auto' | 'on' | 'off';
export type GuardAdapterName = 'dependency-graph' | 'security' | 'dependency-hygiene';

export interface GuardFinding {
  ruleId: string;
  severity: GuardSeverity;
  file: string;
  line: number;
  importPath: string;
  message: string;
  fingerprint: string;
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
  changedOnly?: boolean;
  changedFiles?: Set<string>;
  baseline?: Set<string>;
  includeArchitectureInsights?: boolean;
}

export interface GuardReviewPacket {
  version: 1;
  outcome: GuardOutcomeStatus;
  diffBase?: string;
  changedFiles: string[];
  diff: string;
  truncated: boolean;
  redacted: boolean;
  diffError?: string;
  project: ProjectModel;
  contracts: GuardContract[];
  requirement?: string;
  deterministicFindings: GuardFinding[];
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

export const defaultGuardConfig: GuardConfig = {
  version: 1,
  rules: [],
  contracts: [],
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
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, content, 'utf8');
  renameSync(temporaryPath, path);
}

function writeGuardArtifact(root: string, relativePath: string, value: unknown): void {
  mkdirSync(resolve(root, GUARD_DIR), { recursive: true });
  atomicWriteFile(resolve(root, relativePath), `${JSON.stringify(value, null, 2)}\n`);
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

export function getGuardProposalFreshness(
  model: ProjectModel,
  proposals: GuardProposalFile | undefined,
): GuardProposalFreshness {
  if (!proposals?.projectFingerprint) return 'unknown';
  return proposals.projectFingerprint === fingerprintProjectModel(model) ? 'current' : 'stale';
}

export function loadGuardConfig(root: string): GuardConfig | undefined {
  const value = readJson(resolve(root, GUARD_RULES_FILE));
  if (!isGuardConfig(value)) return undefined;
  const contractsPath = resolve(root, GUARD_CONTRACTS_FILE);
  if (existsSync(contractsPath)) {
    const contractFile = readJson(contractsPath);
    if (!isGuardContractsFile(contractFile)) return undefined;
    return { ...value, contracts: contractFile.contracts };
  }
  return {
    ...value,
    contracts: value.contracts ?? [],
  };
}

export function loadGuardProposals(root: string): GuardProposalFile | undefined {
  const value = readJson(resolve(root, GUARD_PROPOSALS_FILE));
  return isGuardProposalFile(value) ? value : undefined;
}

export function isGuardAgentConfig(value: unknown): value is GuardAgentConfig {
  return guardAgentConfigSchema.safeParse(value).success;
}

export function loadGuardAgentConfig(root: string): GuardAgentConfig {
  const value = readJson(resolve(root, GUARD_AGENT_FILE));
  return isGuardAgentConfig(value) ? value : defaultGuardAgentConfig;
}

export function writeGuardAgentConfig(root: string, agentConfig = defaultGuardAgentConfig): void {
  writeGuardArtifact(root, GUARD_AGENT_FILE, agentConfig);
}

export function loadGuardArtifact(root: string, relativePath: string): unknown {
  return readJson(resolve(root, relativePath));
}

export function loadBaseline(root: string): Set<string> {
  const value = readJson(resolve(root, GUARD_BASELINE_FILE));
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((item): item is string => typeof item === 'string'));
}

export function updateBaseline(
  root: string,
  options: { add?: string[]; remove?: string[]; reason?: string } = {},
): Set<string> {
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
  atomicWriteFile(resolve(root, GUARD_BASELINE_FILE), `${JSON.stringify(fingerprints, null, 2)}\n`);
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
}

export function writeGuardConfig(root: string, guardConfig: GuardConfig): void {
  mkdirSync(resolve(root, GUARD_DIR), { recursive: true });
  const { contracts = [], ...rulesConfig } = guardConfig;
  atomicWriteFile(resolve(root, GUARD_RULES_FILE), `${JSON.stringify(rulesConfig, null, 2)}\n`);
  atomicWriteFile(
    resolve(root, GUARD_CONTRACTS_FILE),
    `${JSON.stringify({ version: 1, contracts }, null, 2)}\n`,
  );
}

export function writeGuardProposals(root: string, proposals: GuardProposalFile): void {
  writeGuardArtifact(root, GUARD_PROPOSALS_FILE, proposals);
}

export function recordGuardProposalDecision(
  root: string,
  decisions: Pick<GuardProposalDecision, 'id' | 'type' | 'decision'>[],
): void {
  const proposals = loadGuardProposals(root);
  if (!proposals || decisions.length === 0) return;
  const decidedAt = new Date().toISOString();
  const nextDecisions = decisions.map((decision) => ({
    ...decision,
    decidedAt,
    ...(proposals.proposalId ? { proposalId: proposals.proposalId } : {}),
    ...(proposals.contentFingerprint ? { proposalFingerprint: proposals.contentFingerprint } : {}),
    ...(typeof proposals.revision === 'number' ? { revision: proposals.revision } : {}),
  }));
  writeGuardProposals(root, {
    ...proposals,
    decisions: [...(proposals.decisions ?? []), ...nextDecisions],
  });
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
    /^(?:@prisma\codapult-guardent|prisma|drizzle-orm|drizzle-kit|typeorm|sequelize|mongoose|knex)(?:\/|$)/i.test(
      importPath,
    );
  const persistenceImports = [
    ...new Set(model.modules.flatMap((module) => module.imports).filter(isPersistenceImport)),
  ].sort();
  const clientPersistenceFiles =
    model.insights.boundaries
      .find((boundary) => boundary.kind === 'client')
      ?.files.filter((file) =>
        model.modules.some(
          (module) =>
            module.path === file &&
            module.imports.some((importPath) => persistenceImports.includes(importPath)),
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
  writeGuardArtifact(root, GUARD_ARCHITECTURE_FILE, buildArchitectureMemory(model));
  writeGuardArtifact(root, GUARD_CONVENTIONS_FILE, buildConventionsMemory(model));
}

export function writeBaseline(root: string, findings: GuardFinding[], model?: ProjectModel): void {
  mkdirSync(resolve(root, GUARD_DIR), { recursive: true });
  const fingerprints = [...new Set(findings.map((finding) => finding.fingerprint))].sort();
  atomicWriteFile(resolve(root, GUARD_BASELINE_FILE), `${JSON.stringify(fingerprints, null, 2)}\n`);
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
}

export function loadProjectModel(root: string): ProjectModel | undefined {
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
  mkdirSync(resolve(root, GUARD_DIR), { recursive: true });
  atomicWriteFile(resolve(root, GUARD_PROJECT_FILE), `${JSON.stringify(model, null, 2)}\n`);
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
    for (const scope of contract.scope ?? []) {
      if (!existsSync(resolve(root, scope))) {
        issues.push({
          contractId: contract.id,
          field: 'scope',
          value: scope,
          message: `Contract scope does not exist: ${scope}`,
        });
      }
    }
    for (const entrypoint of contract.entrypoints ?? []) {
      if (!existsSync(resolve(root, entrypoint))) {
        issues.push({
          contractId: contract.id,
          field: 'scope',
          value: entrypoint,
          message: `Contract entrypoint does not exist: ${entrypoint}`,
        });
      }
    }
    for (const excluded of contract.exclude ?? []) {
      if (!existsSync(resolve(root, excluded))) {
        issues.push({
          contractId: contract.id,
          field: 'scope',
          value: excluded,
          message: `Contract exclusion does not exist: ${excluded}`,
        });
      }
    }
    for (const reference of contract.references ?? []) {
      if (!existsSync(resolve(root, reference))) {
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
  const importPaths = [
    ...new Set([...module.imports, ...module.exports, ...module.dynamicImports]),
  ];
  for (const importPath of importPaths) {
    const line = sourceFile ? importLine(sourceFile, importPath) : 1;
    for (const rule of rules) {
      if (rule.status === 'proposed' || !ruleAppliesToFile(rule, file)) continue;
      if (rule.kind === 'client-forbidden-import' && !isClient) continue;
      if (!rule.patterns.some((pattern) => patternMatches(importPath, pattern))) continue;
      findings.push({
        ruleId: rule.id,
        severity: rule.severity,
        file,
        line,
        importPath,
        message: rule.description,
        fingerprint: `${rule.id}|${file}|${importPath}`,
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
        for (const importPath of module.imports) {
          if (contract.mustNotImport?.some((pattern) => patternMatches(importPath, pattern))) {
            findings.push({
              ruleId: `contract:${contract.id}`,
              severity,
              file: module.path,
              line: 1,
              importPath,
              message: contract.statement,
              fingerprint: `contract-import|${contract.id}|${module.path}|${importPath}`,
            });
          }
        }
        if (
          contract.mustImport !== undefined &&
          contract.mustImport.length > 0 &&
          !module.imports.some((importPath) =>
            contract.mustImport?.some((pattern) => patternMatches(importPath, pattern)),
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
    for (const importPath of module.imports.filter((value) => serverOnlyImports.test(value))) {
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

function isSafeReviewFile(file: string): boolean {
  return !(
    file === '.env' ||
    file.startsWith('.env.') ||
    /(?:credentials|secrets?)/i.test(file) ||
    /\.(?:pem|key|p12|pfx)$/i.test(file)
  );
}

function isSafeReviewPath(root: string, file: string): boolean {
  try {
    const projectRoot = `${realpathSync(root)}${sep}`;
    const target = realpathSync(resolve(root, file));
    return target === projectRoot.slice(0, -1) || target.startsWith(projectRoot);
  } catch {
    return false;
  }
}

/** @internal Redacts common credential shapes before a diff enters an AI review packet. */
export function redactSensitiveText(value: string): {
  value: string;
  redacted: boolean;
  redactionCount: number;
} {
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

function reviewDiff(
  root: string,
  maxChars: number,
  base?: string,
): { diff: string; truncated: boolean; redacted: boolean; changedFiles: string[]; error?: string } {
  try {
    if (base !== undefined && !isSafeGitRevision(base)) {
      return {
        diff: '',
        truncated: false,
        redacted: false,
        changedFiles: [],
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
    };
  } catch (error) {
    const detail = error instanceof Error ? ` (${error.message})` : '';
    return {
      diff: '',
      truncated: false,
      redacted: false,
      changedFiles: [],
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
  const changed = options.changedOnly ? (options.changedFiles ?? changedFiles(root)) : undefined;
  const files = listSourceFiles(root).filter((file) => !changed || changed.has(file));
  const model = discoverProject(root);
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
    ...scanContracts(root, guardConfig.contracts ?? [], changed),
    ...(options.includeArchitectureInsights ? architectureInsightFindings(root, changed) : []),
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
  return {
    version: 1,
    outcome: classifyGuardOutcome({ errors: diff.error ? 1 : 0, needsReview: !diff.error }),
    ...(base ? { diffBase: base } : {}),
    changedFiles: diff.changedFiles,
    diff: diff.diff,
    truncated: diff.truncated,
    redacted: diff.redacted,
    ...(diff.error ? { diffError: diff.error } : {}),
    project,
    contracts: guardConfig.contracts ?? [],
    ...(requirement ? { requirement } : {}),
    deterministicFindings: report.findings,
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
  options: { force?: boolean } = {},
): { config: GuardConfig; report: GuardReport } {
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
  writeGuardMemory(root, projectModel);
  writeProjectModel(root, projectModel);
  writeProjectSnapshot(root, projectModel);
  writeGuardProposals(root, buildGuardProposals(projectModel, guardConfig));
  const initialReport = scanGuard(root, guardConfig, { includeArchitectureInsights: true });
  writeBaseline(root, initialReport.findings, projectModel);
  return { config: guardConfig, report: { ...initialReport, findings: [] } };
}

export { discoverProject, discoverProjectWithMetrics, findGuardRoot };
