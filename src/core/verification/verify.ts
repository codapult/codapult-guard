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
  loadBaseline,
  loadGuardPolicyAtRevision,
  createGuardPolicySnapshot,
  loadGuardWaivers,
  loadGuardAgentConfig,
  loadGuardConfig,
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
} from '../history/runs.js';

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
): GuardRunPolicy {
  return {
    ...(snapshot.revision !== undefined ? { revision: snapshot.revision } : {}),
    fingerprint: snapshot.fingerprint,
    source: snapshot.source,
    ...(base ? { ref: base } : {}),
    ...(base ? { changedFromBase } : {}),
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
  let config;
  try {
    config = loadGuardConfig(root);
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
  if (!config) {
    const run = finishGuardRun(root, runContext, 'not-configured', 'configuration');
    return {
      status: 'not-configured',
      outcome: 'not-configured',
      errorCode: 'GUARD_NOT_CONFIGURED',
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
  try {
    workingTreeSnapshot = createGuardPolicySnapshot(
      config,
      loadBaseline(root),
      loadGuardWaivers(root),
      'working-tree',
      undefined,
      loadGuardAgentConfig(root),
    );
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
    if (options.failOnPolicyChange && policyChanged) {
      const policy = buildRunPolicy(policySnapshot, options.policyBase, policyChanged);
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
  const policy = buildRunPolicy(policySnapshot, options.policyBase, policyChanged);

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
  const missingRequiredTools =
    options.strict &&
    [...Object.values(results), ...Object.values(adapters)].some(
      (result) => result.status === 'not-configured',
    );
  const architectureFailed = architecture.findings.some((finding) => finding.severity === 'error');
  const architectureWarnings =
    architecture.findings.some((finding) => finding.severity === 'warning') ||
    (architecture.waiverWarnings ?? []).length > 0;
  const failed =
    (projectChecks && !runtime.compatible) ||
    commandFailed ||
    workspaceCommandFailed ||
    adapterFailed ||
    architectureFailed ||
    contractIssues.length > 0 ||
    missingRequiredTools;
  const projectChecksFailed =
    commandFailed || workspaceCommandFailed || (projectChecks && !runtime.compatible);
  const adaptersFailed = adapterFailed || missingRequiredTools;
  runContext.stages['project-checks'] = {
    ...runContext.stages['project-checks'],
    status: projectChecks ? (projectChecksFailed ? 'fail' : 'ok') : 'skipped',
  };
  runContext.stages.adapters = {
    ...runContext.stages.adapters,
    status: toolMode === 'off' ? 'skipped' : adaptersFailed ? 'fail' : 'ok',
  };
  runContext.stages['architecture-policy'] = {
    ...runContext.stages['architecture-policy'],
    status: architectureFailed || contractIssues.length > 0 ? 'fail' : 'ok',
  };
  const outcome = classifyGuardOutcome({
    errors: failed ? 1 : 0,
    warnings: architectureWarnings ? 1 : 0,
  });
  const gate = architectureFailed
    ? 'architecture'
    : contractIssues.length > 0
      ? 'contracts'
      : commandFailed || workspaceCommandFailed
        ? 'project-checks'
        : adapterFailed
          ? 'adapters'
          : missingRequiredTools
            ? 'required-tools'
            : !runtime.compatible && projectChecks
              ? 'runtime'
              : 'none';
  const run = finishGuardRun(root, runContext, outcome, gate, 'verify', policy);
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
