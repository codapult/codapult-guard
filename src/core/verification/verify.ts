import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
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
  loadGuardPolicyAtRevision,
  loadGuardWorkingTreePolicy,
  scanGuard,
  classifyGuardOutcome,
  validateGuardPolicy,
  type GuardToolMode,
  type GuardContractIssue,
  type GuardReport,
  type GuardPolicySnapshot,
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
} from '../history/runs.js';

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
}

export interface GuardVerificationResult {
  status: 'ok' | 'fail' | 'not-configured';
  outcome: 'pass' | 'fail' | 'warning' | 'needs-review' | 'not-configured';
  errorCode?:
    | 'GUARD_NOT_CONFIGURED'
    | 'GUARD_CONFIG_INVALID'
    | 'GUARD_POLICY_BASE_INVALID'
    | 'GUARD_POLICY_CHANGED'
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

function receiptCheck(result: CommandResult): GuardVerificationReceiptCheck {
  return {
    status: result.status,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
  };
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

function changedFilesSince(root: string, baseRef: string | undefined): string[] | undefined {
  if (!baseRef) return undefined;
  try {
    return execFileSync('git', ['diff', '--name-only', `${baseRef}...HEAD`], {
      cwd: root,
      stdio: 'pipe',
      timeout: 5_000,
    })
      .toString()
      .split('\n')
      .map((file) => file.trim().replace(/\\/g, '/'))
      .filter(Boolean)
      .sort();
  } catch {
    return undefined;
  }
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
): Omit<GuardVerificationReceipt, 'runId' | 'generatedAt' | 'outcome' | 'gate' | 'subject'> &
  Pick<GuardVerificationReceipt, 'subject'> {
  const baseCommit = resolveGitCommit(root, policy.ref);
  const baseChangedFiles = changedFilesSince(root, policy.ref);
  const workingTreeFiles = impact.requestedFiles;
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
      ...(policy.ref ? { baseRef: policy.ref } : {}),
      ...(baseCommit ? { baseCommit } : {}),
      ...(baseChangedFiles ? { baseChangedFiles } : {}),
      ...(workingTreeFiles.length > 0 ? { workingTreeFiles } : {}),
      changedFiles: [...new Set([...(baseChangedFiles ?? []), ...workingTreeFiles])].sort(),
      workingTreeDirty: workingTreeFiles.length > 0,
    },
    policy,
    stages,
    checks: receiptChecks,
    findings: {
      total: architecture.findings.length,
      errors: architecture.findings.filter((finding) => finding.severity === 'error').length,
      warnings: architecture.findings.filter((finding) => finding.severity === 'warning').length,
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
  if (options.failOnPolicyChange && !options.policyBase) {
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
      configError: '`failOnPolicyChange` requires `policyBase`.',
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
      const run = finishGuardRun(root, runContext, 'fail', 'policy-change', 'verify', policy);
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
  const checksStartedAt = Date.now();
  const results = runProjectChecks(root, checks, { timeout: options.timeout });
  recordGuardRunStage(
    runContext,
    'project-checks',
    projectChecks ? 'ok' : 'skipped',
    checksStartedAt,
  );
  const discoveryStartedAt = Date.now();
  const workspaceModel = discoverProject(root);
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
  const failed =
    runtimeFailed ||
    commandFailed ||
    workspaceCommandFailed ||
    adapterFailed ||
    architectureFailed ||
    expiredWaivers ||
    contractIssues.length > 0 ||
    missingProjectChecks ||
    missingAdapterTools;
  const projectChecksFailed =
    commandFailed || workspaceCommandFailed || missingProjectChecks || runtimeFailed;
  const adaptersFailed = adapterFailed || missingAdapterTools;
  runContext.stages['project-checks'] = {
    ...runContext.stages['project-checks'],
    status: projectChecks ? (projectChecksFailed ? 'fail' : 'ok') : 'skipped',
  };
  runContext.stages.adapters = {
    ...runContext.stages.adapters,
    status: toolMode === 'off' ? 'skipped' : adaptersFailed ? 'fail' : 'ok',
  };
  runContext.stages.runtime = {
    ...runContext.stages.runtime,
    status: runtimeFailed ? 'fail' : 'ok',
  };
  runContext.stages['architecture-policy'] = {
    ...runContext.stages['architecture-policy'],
    status: architectureFailed || expiredWaivers || contractIssues.length > 0 ? 'fail' : 'ok',
  };
  const outcome = classifyGuardOutcome({
    errors: failed ? 1 : 0,
    warnings: architectureWarnings ? 1 : 0,
  });
  const gate =
    architectureFailed || expiredWaivers
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
  );
  const run = finishGuardRun(root, runContext, outcome, gate, 'verify', policy, receipt);
  return {
    status: failed ? 'fail' : 'ok',
    outcome,
    tools: toolMode,
    checks: results,
    workspaceChecks,
    adapters,
    runtime,
    architecture,
    impact,
    contractIssues,
    requirement,
    run,
    policy,
    ...(policy.changedFromBase !== undefined ? { policyChanged: policy.changedFromBase } : {}),
  };
}
