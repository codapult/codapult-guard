import { type CommandResult } from '../../adapters/command.js';
import {
  runProjectAdapters,
  runProjectChecks,
  runWorkspaceProjectChecks,
  inspectProjectRuntime,
  type GuardAdapter,
  type ProjectCheck,
  type ProjectCheckResults,
  type ProjectRuntimeDiagnostics,
} from '../../adapters/project-checks.js';
import {
  loadBaseline,
  loadGuardAgentConfig,
  loadGuardConfig,
  scanGuard,
  classifyGuardOutcome,
  validateGuardContracts,
  type GuardToolMode,
  type GuardContractIssue,
  type GuardReport,
} from '../guard.js';
import { discoverProject } from '../discovery/discovery.js';

export type GuardVerificationCheck = ProjectCheck;

export interface GuardVerificationResult {
  status: 'ok' | 'fail' | 'not-configured';
  outcome: 'pass' | 'fail' | 'warning' | 'needs-review' | 'not-configured';
  tools?: GuardToolMode;
  checks: ProjectCheckResults;
  workspaceChecks: Record<string, ProjectCheckResults>;
  adapters: Partial<Record<GuardAdapter, CommandResult>>;
  runtime: ProjectRuntimeDiagnostics;
  architecture?: GuardReport;
  contractIssues: GuardContractIssue[];
  requirement: {
    status: 'delegated-to-review';
    provided: boolean;
    message: string;
  };
}

export function runGuardVerification(
  root: string,
  options: {
    checks?: GuardVerificationCheck[];
    changedOnly?: boolean;
    timeout?: number;
    requirement?: string;
    tools?: GuardToolMode;
    strict?: boolean;
    projectChecks?: boolean;
  } = {},
): GuardVerificationResult {
  const config = loadGuardConfig(root);
  const requirement = {
    status: 'delegated-to-review' as const,
    provided: Boolean(options.requirement?.trim()),
    message: options.requirement?.trim()
      ? 'Requirement text is included in semantic review input; deterministic verify does not judge natural-language acceptance criteria.'
      : 'Requirement satisfaction is evaluated by guard review using the task and diff.',
  };
  const runtime = inspectProjectRuntime(root);
  if (!config)
    return {
      status: 'not-configured',
      outcome: 'not-configured',
      checks: {},
      workspaceChecks: {},
      adapters: {},
      runtime,
      contractIssues: [],
      requirement,
    };

  const agentConfig = loadGuardAgentConfig(root);
  const projectChecks = options.projectChecks ?? agentConfig.completionGate.projectChecks;
  const checks = projectChecks ? (options.checks ?? agentConfig.completionGate.checks) : [];
  const results = runProjectChecks(root, checks, { timeout: options.timeout });
  const workspaceModel = discoverProject(root);
  const workspaceChecks = runWorkspaceProjectChecks(
    root,
    workspaceModel.project.workspacePackages ?? [],
    checks,
    {
      timeout: options.timeout,
      rootResults: results,
    },
  );
  const toolMode = options.tools ?? agentConfig.tools;
  const adapters =
    toolMode === 'off'
      ? {}
      : runProjectAdapters(root, {
          mode: toolMode,
          timeout: options.timeout,
          tooling: agentConfig.tooling,
        });

  const architecture = scanGuard(root, config, {
    changedOnly: options.changedOnly,
    baseline: loadBaseline(root),
    includeArchitectureInsights: true,
  });
  const contractIssues = validateGuardContracts(root, config.contracts ?? []);
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
  const architectureWarnings = architecture.findings.some(
    (finding) => finding.severity === 'warning',
  );
  const failed =
    (projectChecks && !runtime.compatible) ||
    commandFailed ||
    workspaceCommandFailed ||
    adapterFailed ||
    architectureFailed ||
    contractIssues.length > 0 ||
    missingRequiredTools;
  return {
    status: failed ? 'fail' : 'ok',
    outcome: classifyGuardOutcome({
      errors: failed ? 1 : 0,
      warnings: architectureWarnings ? 1 : 0,
    }),
    tools: toolMode,
    checks: results,
    workspaceChecks,
    adapters,
    runtime,
    architecture,
    contractIssues,
    requirement,
  };
}
