import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  buildArchitectureMemory,
  buildConventionsMemory,
  buildGeneratedGuardConfig,
  buildGuardProposals,
  buildGuardReviewPacket,
  discoverProject,
  discoverProjectWithMetrics,
  fingerprintProjectModel,
  findGuardRoot,
  GUARD_ARCHITECTURE_FILE,
  GUARD_CONVENTIONS_FILE,
  loadBaseline,
  loadGuardArtifact,
  loadGuardConfig,
  loadGuardAgentConfig,
  loadGuardProposals,
  loadGuardWaivers,
  getPendingGuardProposals,
  getGuardProposalFreshness,
  loadProjectModel,
  writeGuardProposals,
  initializeGuard,
  GuardAlreadyInitializedError,
  GuardStateBusyError,
  GuardStateStaleError,
  applyGuardProposalDecision,
  validateGuardProposalApproval,
  writeProjectState,
  scanGuard,
  updateGuardWaivers,
  validateGuardPolicy,
  classifyGuardOutcome,
  getGuardPolicyMutationPolicy,
  type GuardConfig,
  type GuardWaiver,
} from '../../core/guard.js';
import { guardErrorPayload } from '../../core/errors.js';
import { analyzeProjectImpact } from '../../core/analysis/impact.js';
import { z } from 'zod';
import { runGuardVerification } from '../../core/verification/verify.js';
import { auditGuardGovernance } from '../../core/audit/governance.js';
import { buildGuardContextState } from '../context.js';

const rootSchema = z.string().trim().min(1).optional().describe('Project path or workspace root.');

interface JsonToolResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean | undefined;
}

interface GuardConfigLoadResult {
  config?: GuardConfig | undefined;
  error?: JsonToolResult | undefined;
}

interface GuardBaselineLoadResult {
  baseline?: Set<string> | undefined;
  error?: JsonToolResult | undefined;
}

interface GuardWaiversLoadResult {
  waivers?: GuardWaiver[] | undefined;
  error?: JsonToolResult | undefined;
}

function asGuardContextRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function getGuardRoot(root?: string): string {
  return root ? findGuardRoot(root) : findGuardRoot();
}

function jsonToolResult(value: unknown, isError = false): JsonToolResult {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function waiverToolError(error: unknown): JsonToolResult {
  return jsonToolResult(
    {
      status: 'invalid',
      message: error instanceof Error ? error.message : 'Waiver update failed.',
    },
    true,
  );
}

function notConfiguredToolResult(): ReturnType<typeof jsonToolResult> {
  return jsonToolResult(
    {
      status: 'error',
      outcome: 'not-configured',
      configured: false,
      errorCode: 'GUARD_NOT_CONFIGURED',
      message: 'Guard is not initialized.',
      recoverable: true,
    },
    true,
  );
}

function loadConfigSafely(root: string): GuardConfigLoadResult {
  try {
    return { config: loadGuardConfig(root) };
  } catch (error) {
    return {
      error: jsonToolResult(
        guardErrorPayload(
          'GUARD_CONFIG_INVALID',
          error instanceof Error ? error.message : String(error),
          {
            configured: false,
            outcome: 'error',
            recoverable: true,
            hint: 'Repair the invalid Guard artifact, then run codapult-guard doctor.',
          },
        ),
        true,
      ),
    };
  }
}

function loadBaselineSafely(root: string): GuardBaselineLoadResult {
  try {
    return { baseline: loadBaseline(root) };
  } catch (error) {
    return {
      error: jsonToolResult(
        guardErrorPayload(
          'GUARD_CONFIG_INVALID',
          error instanceof Error ? error.message : String(error),
          {
            configured: true,
            outcome: 'error',
            recoverable: true,
            hint: 'Repair baseline.json, then run codapult-guard doctor.',
          },
        ),
        true,
      ),
    };
  }
}

function loadWaiversSafely(root: string): GuardWaiversLoadResult {
  try {
    return { waivers: loadGuardWaivers(root) };
  } catch (error) {
    return {
      error: jsonToolResult(
        guardErrorPayload(
          'GUARD_CONFIG_INVALID',
          error instanceof Error ? error.message : String(error),
          {
            configured: true,
            outcome: 'error',
            recoverable: true,
            hint: 'Repair waivers.json, then run codapult-guard doctor.',
          },
        ),
        true,
      ),
    };
  }
}

function stateErrorResult(error: unknown): ReturnType<typeof jsonToolResult> | undefined {
  const isBusy = error instanceof GuardStateBusyError;
  const isStale = error instanceof GuardStateStaleError;
  if (!isBusy && !isStale) return undefined;
  return jsonToolResult(
    guardErrorPayload(isBusy ? 'GUARD_STATE_BUSY' : 'GUARD_STATE_STALE', String(error), {
      configured: true,
      outcome: 'error',
      recoverable: true,
      hint: 'Re-read Guard state and retry the operation.',
    }),
    true,
  );
}

function loadAgentSafely(
  root: string,
):
  | { config: ReturnType<typeof loadGuardAgentConfig> }
  | { error: ReturnType<typeof jsonToolResult> } {
  try {
    return { config: loadGuardAgentConfig(root) };
  } catch (error) {
    return {
      error: jsonToolResult(
        guardErrorPayload(
          'GUARD_CONFIG_INVALID',
          error instanceof Error ? error.message : String(error),
          {
            configured: false,
            outcome: 'error',
            recoverable: true,
            hint: 'Repair agent.json, then run codapult-guard doctor.',
          },
        ),
        true,
      ),
    };
  }
}

function loadProposalsSafely(
  root: string,
):
  | { proposals: ReturnType<typeof loadGuardProposals> }
  | { error: ReturnType<typeof jsonToolResult> } {
  try {
    return { proposals: loadGuardProposals(root) };
  } catch (error) {
    return {
      error: jsonToolResult(
        guardErrorPayload(
          'GUARD_CONFIG_INVALID',
          error instanceof Error ? error.message : String(error),
          {
            configured: false,
            outcome: 'error',
            recoverable: true,
            hint: 'Repair proposals.json, then run codapult-guard doctor.',
          },
        ),
        true,
      ),
    };
  }
}

export function registerGuardTools(server: McpServer): void {
  server.registerTool(
    'codapult_guard_analyze',
    {
      title: 'Refresh Guard Model',
      description:
        'Rediscover the repository and persist its current project facts and snapshots. Use after repository changes when codapult_guard_next_action returns needs-refresh or needs-setup; this does not change Guard rules, contracts, or baseline. Returns the new revision and discovery metrics.',
      inputSchema: {
        root: rootSchema,
        confirm: z
          .boolean()
          .default(false)
          .describe('Required before writing refreshed Guard state.'),
        wait_ms: z
          .number()
          .int()
          .min(0)
          .max(120_000)
          .default(30_000)
          .describe('Maximum time to wait for the Guard state lock, in milliseconds.'),
        no_wait: z
          .boolean()
          .default(false)
          .describe('Return immediately if another process holds the Guard state lock.'),
      },
    },
    ({ root: requestedRoot, confirm, wait_ms, no_wait }) => {
      const root = getGuardRoot(requestedRoot);
      if (!confirm) return jsonToolResult({ status: 'needs-confirmation', action: 'analyze' });
      const discovery = discoverProjectWithMetrics(root, { persistCache: true });
      let revision: string;
      try {
        revision = writeProjectState(root, discovery.model, {
          waitMs: wait_ms,
          noWait: no_wait,
        });
      } catch (error) {
        return (
          stateErrorResult(error) ??
          jsonToolResult({ status: 'fail', message: String(error) }, true)
        );
      }
      return jsonToolResult({
        status: 'ok',
        action: 'analyze',
        revision,
        discovery: discovery.metrics,
      });
    },
  );

  server.registerTool(
    'codapult_guard_next_action',
    {
      title: 'Guard Next Action',
      description:
        'Choose the next bounded step in the Guard workflow without writing project files. Call at task start or after a step: it checks setup, stale project facts/proposals, changed-file findings, and policy contracts, then returns an action such as init, analyze, policy review, repair, or verify with the reason.',
      inputSchema: { root: rootSchema },
    },
    ({ root: requestedRoot }) => {
      const root = getGuardRoot(requestedRoot);
      const loaded = loadConfigSafely(root);
      if (loaded.error) return loaded.error;
      const config = loaded.config;
      if (!config) {
        return jsonToolResult({
          status: 'needs-setup',
          action: 'init',
          reason: 'Guard policy is not initialized.',
        });
      }
      const project = discoverProject(root);
      const persisted = loadProjectModel(root);
      if (
        persisted &&
        'project' in persisted &&
        fingerprintProjectModel(persisted) !== fingerprintProjectModel(project)
      ) {
        return jsonToolResult({
          status: 'needs-refresh',
          action: 'analyze',
          reason: 'Persisted Guard project facts are stale after repository changes.',
          canRetry: false,
        });
      }
      const loadedProposals = loadProposalsSafely(root);
      if ('error' in loadedProposals) return loadedProposals.error;
      const proposals = loadedProposals.proposals;
      const proposedCount = getPendingGuardProposals(proposals).length;
      if (proposals && getGuardProposalFreshness(project, proposals) === 'stale') {
        return jsonToolResult({
          status: 'needs-decision',
          action: 'propose',
          reason: 'Guard proposals are stale after project changes.',
          canRetry: false,
        });
      }
      if (proposedCount > 0) {
        return jsonToolResult({
          status: 'needs-decision',
          action: 'policy-review',
          reason: `${proposedCount} proposed policy item(s) await explicit approval or rejection.`,
          canRetry: false,
        });
      }
      const loadedBaseline = loadBaselineSafely(root);
      if (loadedBaseline.error) return loadedBaseline.error;
      const report = scanGuard(root, config, {
        changedOnly: true,
        baseline: loadedBaseline.baseline,
        includeArchitectureInsights: true,
      });
      const contractIssues = validateGuardPolicy(root, config);
      if (report.findings.some((finding) => finding.severity === 'error')) {
        return jsonToolResult({
          status: 'needs-repair',
          action: 'repair',
          reason: 'Active architecture findings remain in changed files.',
          findings: report.findings,
          canRetry: true,
        });
      }
      if (contractIssues.length > 0) {
        return jsonToolResult({
          status: 'needs-decision',
          action: 'policy-repair',
          reason: 'Guard contracts are stale or invalid.',
          contractIssues,
          canRetry: false,
        });
      }
      return jsonToolResult({
        status: 'ready-for-verification',
        action: 'verify',
        reason: 'No changed-file architecture regressions remain.',
        canRetry: true,
      });
    },
  );

  server.registerTool(
    'codapult_guard_context',
    {
      title: 'Guard Context',
      description:
        'Read the project model, architecture insights, conventions, active policy, proposals, baseline, waivers, and completion-gate settings in one structured response. Works before Guard initialization. Use refresh=true (default) for current repository state; refresh=false prefers persisted snapshots and is useful when inspecting the last saved model.',
      inputSchema: {
        root: rootSchema,
        refresh: z
          .boolean()
          .default(true)
          .describe(
            'Rediscover the working tree and derive current context; false prefers persisted model and memory artifacts.',
          ),
      },
    },
    ({ root: requestedRoot, refresh }) => {
      const root = getGuardRoot(requestedRoot);
      const loaded = loadConfigSafely(root);
      if (loaded.error) return loaded.error;
      const config = loaded.config;
      const agent = loadAgentSafely(root);
      if ('error' in agent) return agent.error;
      const agentConfig = agent.config;
      const discovery = refresh
        ? discoverProjectWithMetrics(root, { persistCache: true })
        : { model: loadProjectModel(root) ?? discoverProject(root), metrics: undefined };
      const project = discovery.model;
      const architecture = asGuardContextRecord(
        refresh
          ? buildArchitectureMemory(project)
          : (loadGuardArtifact(root, GUARD_ARCHITECTURE_FILE) ?? buildArchitectureMemory(project)),
      );
      const conventions = asGuardContextRecord(
        refresh
          ? buildConventionsMemory(project)
          : (loadGuardArtifact(root, GUARD_CONVENTIONS_FILE) ?? buildConventionsMemory(project)),
      );
      const loadedProposals = loadProposalsSafely(root);
      if ('error' in loadedProposals) return loadedProposals.error;
      const loadedBaseline = loadBaselineSafely(root);
      if (loadedBaseline.error) return loadedBaseline.error;
      const loadedWaivers = loadWaiversSafely(root);
      if (loadedWaivers.error) return loadedWaivers.error;
      const state = buildGuardContextState(
        project,
        discovery.metrics,
        architecture,
        conventions,
        config,
        loadedProposals.proposals,
        loadedBaseline.baseline ?? new Set(),
        loadedWaivers.waivers ?? [],
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                version: 1,
                status: 'ok',
                outcome: classifyGuardOutcome({ configured: config !== undefined }),
                configured: config !== undefined,
                tools: agentConfig.tools,
                tooling: agentConfig.tooling,
                completionGate: agentConfig.completionGate,
                mutationPolicy: getGuardPolicyMutationPolicy(config),
                ...state,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'codapult_guard_propose',
    {
      title: 'Guard Proposals',
      description:
        'Generate evidence-backed candidate architecture rules and contracts from the current project model. Use to review possible policy after setup or structural changes; proposals are never activated automatically. The result includes evidence, questions, freshness, and persistence status. Persisted proposals still require an explicit decision with codapult_guard_proposal_decide.',
      inputSchema: {
        root: rootSchema,
        persist: z
          .boolean()
          .default(false)
          .describe(
            'Write the generated packet to proposals.json; false returns it without changing project state.',
          ),
        confirm: z
          .boolean()
          .default(false)
          .describe('Must be true to persist proposals; has no effect on read-only generation.'),
      },
    },
    ({ root: requestedRoot, persist, confirm }) => {
      const root = getGuardRoot(requestedRoot);
      if (persist && !confirm)
        return jsonToolResult({ status: 'needs-confirmation', persist: true });
      const project = discoverProject(root);
      const loaded = loadConfigSafely(root);
      if (loaded.error) return loaded.error;
      const config = loaded.config ?? buildGeneratedGuardConfig(project);
      const proposals = buildGuardProposals(project, config);
      const loadedPrevious = loadProposalsSafely(root);
      if ('error' in loadedPrevious) return loadedPrevious.error;
      const previous = loadedPrevious.proposals;
      if (persist) {
        writeGuardProposals(root, {
          ...proposals,
          ...(previous?.decisions ? { decisions: previous.decisions } : {}),
        });
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                status: 'ok',
                ...proposals,
                freshness: getGuardProposalFreshness(project, proposals),
                previousFreshness: getGuardProposalFreshness(project, previous),
                persisted: persist,
                instructions:
                  'Review evidence and questions with the user or host AI before activating any proposal.',
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'codapult_guard_init',
    {
      title: 'Initialize Guard',
      description:
        'Create the initial Guard policy, project model, and supporting artifacts for a repository that has not been initialized. Existing Guard state is preserved by default. Use force only to replace existing state after reviewing the consequences; the result reports initialization findings.',
      inputSchema: {
        root: rootSchema,
        confirm: z.boolean().default(false).describe('Required before writing Guard artifacts.'),
        force: z
          .boolean()
          .default(false)
          .describe(
            'Replace existing Guard artifacts, including the baseline; requires confirm=true.',
          ),
        wait_ms: z
          .number()
          .int()
          .min(0)
          .max(120_000)
          .default(30_000)
          .describe('Maximum time to wait for the Guard state lock, in milliseconds.'),
        no_wait: z
          .boolean()
          .default(false)
          .describe('Return immediately if another process holds the Guard state lock.'),
      },
    },
    ({ root: requestedRoot, confirm, force, wait_ms, no_wait }) => {
      const root = getGuardRoot(requestedRoot);
      if (!confirm) return jsonToolResult({ status: 'needs-confirmation', root, force });
      const loadedConfig = loadConfigSafely(root);
      if (loadedConfig.error) return loadedConfig.error;
      if (
        force &&
        loadedConfig.config?.approval?.mode === 'protected' &&
        !loadedConfig.config.approval.allowMcpApproval
      ) {
        return jsonToolResult(
          {
            status: 'approval-required',
            message:
              'Protected Guard policy requires forced initialization outside the MCP agent surface.',
            source: 'mcp',
            force,
          },
          true,
        );
      }
      try {
        const result = initializeGuard(root, { force, waitMs: wait_ms, noWait: no_wait });
        return jsonToolResult({ status: 'ok', root, report: result.report });
      } catch (error) {
        const stateError = stateErrorResult(error);
        if (stateError) return stateError;
        const status =
          error instanceof GuardAlreadyInitializedError ? 'already-initialized' : 'fail';
        return jsonToolResult(
          { status, root, message: error instanceof Error ? error.message : String(error) },
          true,
        );
      }
    },
  );

  server.registerTool(
    'codapult_guard_proposal_decide',
    {
      title: 'Decide Guard Proposals',
      description:
        'Record an explicit approval or rejection for the selected current proposals. Approval activates the selected rules/contracts in Guard policy; rejection records the decision without activation. Stale proposals cannot be decided, and protected approval policy may require a non-MCP reviewer. Returns the decision and affected IDs.',
      inputSchema: {
        root: rootSchema,
        ids: z
          .array(z.string().trim().min(1))
          .min(1)
          .describe('One or more proposal IDs from the current codapult_guard_propose result.'),
        decision: z
          .enum(['approved', 'rejected'])
          .describe('Whether to activate the selected proposal(s) or record their rejection.'),
        confirm: z
          .boolean()
          .default(false)
          .describe('Must be true before recording decisions or activating proposals.'),
      },
    },
    ({ root: requestedRoot, ids, decision, confirm }) => {
      const root = getGuardRoot(requestedRoot);
      const loadedProposals = loadProposalsSafely(root);
      if ('error' in loadedProposals) return loadedProposals.error;
      const proposals = loadedProposals.proposals;
      if (!proposals)
        return jsonToolResult({ status: 'not-configured', message: 'No proposals found.' }, true);
      const project = discoverProject(root);
      if (getGuardProposalFreshness(project, proposals) === 'stale') {
        return jsonToolResult(
          { status: 'stale', message: 'Regenerate proposals before deciding on them.' },
          true,
        );
      }
      const selected = [...proposals.rules, ...proposals.contracts].filter((item) =>
        ids.includes(item.id),
      );
      const missing = ids.filter((id) => !selected.some((item) => item.id === id));
      if (missing.length > 0) return jsonToolResult({ status: 'invalid', missing }, true);
      const loadedConfig = loadConfigSafely(root);
      if (loadedConfig.error) return loadedConfig.error;
      const approval = loadedConfig.config?.approval;
      if (decision === 'approved' && approval?.mode === 'protected' && !approval.allowMcpApproval) {
        return jsonToolResult(
          {
            status: 'approval-required',
            message: 'Protected Guard policy requires approval outside the MCP agent surface.',
            source: 'mcp',
            ids,
          },
          true,
        );
      }
      if (decision === 'approved') {
        const approvalError = validateGuardProposalApproval(approval, proposals);
        if (approvalError) {
          return jsonToolResult(
            { status: 'approval-required', message: approvalError, source: 'mcp', ids },
            true,
          );
        }
      }
      if (!confirm) return jsonToolResult({ status: 'needs-confirmation', decision, ids });
      if (decision === 'approved') {
        const config = loadedConfig.config ?? { version: 1 as const, rules: [], contracts: [] };
        const nextRules = [...config.rules];
        const nextContracts = [...(config.contracts ?? [])];
        for (const item of selected) {
          if ('statement' in item) {
            const index = nextContracts.findIndex((contract) => contract.id === item.id);
            const active = { ...item, status: 'active' as const };
            if (index >= 0) nextContracts[index] = active;
            else nextContracts.push(active);
          } else {
            const index = nextRules.findIndex((rule) => rule.id === item.id);
            const active = { ...item, status: 'active' as const };
            if (index >= 0) nextRules[index] = active;
            else nextRules.push(active);
          }
        }
        applyGuardProposalDecision(
          root,
          { version: 1, rules: nextRules, contracts: nextContracts },
          selected.map((item) => ({
            id: item.id,
            type: 'statement' in item ? ('contract' as const) : ('rule' as const),
            decision,
          })),
          { source: 'mcp' },
        );
      } else {
        applyGuardProposalDecision(
          root,
          loadedConfig.config ?? { version: 1 as const, rules: [], contracts: [] },
          selected.map((item) => ({
            id: item.id,
            type: 'statement' in item ? ('contract' as const) : ('rule' as const),
            decision,
          })),
          { source: 'mcp' },
        );
      }
      return jsonToolResult({ status: 'ok', root, decision, ids });
    },
  );

  server.registerTool(
    'codapult_guard_verify',
    {
      title: 'Guard Verify',
      description:
        'Run the configured completion gate: selected project checks plus Guard architecture and policy checks, returning structured results. Use after implementation and semantic review; this executes project commands but does not edit source. Defaults come from agent.json where omitted. Pass requirement to bind verification to the task and increment iteration on each retry.',
      inputSchema: {
        root: rootSchema,
        checks: z
          .array(z.enum(['lint', 'typecheck', 'test', 'build']))
          .optional()
          .describe(
            'Project checks to run; when omitted, uses the configured gate (normally lint, typecheck, test, and build).',
          ),
        changed_only: z
          .boolean()
          .optional()
          .describe(
            'Limit architecture regression checks to changed files; omitted uses configured behavior.',
          ),
        requirement: z
          .string()
          .trim()
          .min(1)
          .max(20_000)
          .optional()
          .describe(
            'The user task or acceptance requirement to include in the verification report.',
          ),
        tools: z
          .enum(['auto', 'on', 'off'])
          .optional()
          .describe(
            'Whether configured external verification tools are enabled; omitted uses agent.json.',
          ),
        strict: z
          .boolean()
          .optional()
          .describe(
            'Enable strict verification behavior, including failure for required but unconfigured checks.',
          ),
        project_checks: z
          .boolean()
          .optional()
          .describe('Override whether project commands run for this invocation.'),
        policy_base: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe('Git ref from which to load the Guard policy for this verification.'),
        fail_on_policy_change: z
          .boolean()
          .optional()
          .describe('Fail if the checked-out Guard policy differs from policy_base.'),
        fail_on_protected_changes: z
          .boolean()
          .optional()
          .describe('Fail if verification-sensitive files or inline suppressions changed.'),
        iteration: z
          .number()
          .int()
          .positive()
          .default(1)
          .describe(
            'Current verification attempt, used to report whether another retry is allowed.',
          ),
      },
    },
    ({
      root: requestedRoot,
      checks,
      changed_only,
      requirement,
      tools,
      strict,
      project_checks,
      policy_base,
      fail_on_policy_change,
      fail_on_protected_changes,
      iteration,
    }) => {
      const root = getGuardRoot(requestedRoot);
      const agent = loadAgentSafely(root);
      if ('error' in agent) return agent.error;
      const result = runGuardVerification(root, {
        checks,
        changedOnly: changed_only,
        requirement,
        tools,
        strict,
        projectChecks: project_checks,
        policyBase: policy_base,
        failOnPolicyChange: fail_on_policy_change,
        failOnProtectedChanges: fail_on_protected_changes,
      });
      const completionGate = agent.config.completionGate;
      return jsonToolResult(
        {
          ...result,
          completionGate: {
            ...completionGate,
            iteration,
            canRetry:
              (result.status === 'fail' || result.status === 'incomplete') &&
              iteration < completionGate.maxIterations,
          },
        },
        result.status !== 'ok',
      );
    },
  );

  server.registerTool(
    'codapult_guard_governance',
    {
      title: 'Guard Governance Audit',
      description:
        'Inspect proposal and approval provenance metadata, policy bindings, and whether retained verification evidence is reachable from decisions. Use for a governance trail audit; output describes declared metadata and does not authenticate identities or verify signatures.',
      inputSchema: { root: rootSchema },
    },
    ({ root: requestedRoot }) => {
      try {
        return jsonToolResult(auditGuardGovernance(getGuardRoot(requestedRoot)));
      } catch (error) {
        return jsonToolResult(
          { status: 'fail', message: error instanceof Error ? error.message : String(error) },
          true,
        );
      }
    },
  );

  server.registerTool(
    'codapult_guard_audit',
    {
      title: 'Guard Audit',
      description:
        'Scan the entire current repository against active Guard rules, including findings normally hidden by the baseline, and validate policy contracts. Use for a full health review; unlike codapult_guard_check, this is not limited to changed files. Returns findings, contract issues, counts, and overall status.',
      inputSchema: { root: rootSchema },
    },
    ({ root: requestedRoot }) => {
      const root = getGuardRoot(requestedRoot);
      const loaded = loadConfigSafely(root);
      if (loaded.error) return loaded.error;
      const config = loaded.config;
      if (!config) {
        return notConfiguredToolResult();
      }
      const report = scanGuard(root, config, { includeArchitectureInsights: true });
      const contractIssues = validateGuardPolicy(root, config);
      const errors = report.findings.filter((finding) => finding.severity === 'error').length;
      const warnings = report.findings.filter((finding) => finding.severity === 'warning').length;
      const status =
        errors > 0 || contractIssues.length > 0 ? 'fail' : warnings > 0 ? 'warning' : 'ok';
      return jsonToolResult(
        {
          status,
          outcome: classifyGuardOutcome({
            errors: errors + contractIssues.length,
            warnings,
          }),
          errors,
          warnings,
          contractIssues,
          report,
        },
        status === 'fail',
      );
    },
  );

  server.registerTool(
    'codapult_guard_review',
    {
      title: 'Prepare Guard Review',
      description:
        'Build a bounded packet for an AI semantic reviewer containing the diff, project context, active contracts, and deterministic Guard findings. Use after coding and before verification. The result needs human/agent review; it is not itself an approval or verification. Set base for PR comparisons and requirement to focus the review.',
      inputSchema: {
        root: rootSchema,
        changed_only: z
          .boolean()
          .default(true)
          .describe(
            'Include only changed-file findings and baseline-aware results; false requests a full-scope packet.',
          ),
        max_diff_chars: z
          .number()
          .int()
          .positive()
          .max(500_000)
          .default(120_000)
          .describe('Maximum number of diff characters included in the packet.'),
        requirement: z
          .string()
          .trim()
          .min(1)
          .max(20_000)
          .optional()
          .describe('The task requirement the reviewer should assess.'),
        base: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe('Git base ref for PR review, e.g. origin/main.'),
      },
    },
    ({ root: requestedRoot, changed_only, max_diff_chars, requirement, base }) => {
      const root = getGuardRoot(requestedRoot);
      const loaded = loadConfigSafely(root);
      if (loaded.error) return loaded.error;
      const config = loaded.config;
      if (!config) {
        return notConfiguredToolResult();
      }
      const loadedBaseline: GuardBaselineLoadResult = changed_only
        ? loadBaselineSafely(root)
        : { baseline: new Set<string>() };
      if (loadedBaseline.error) return loadedBaseline.error;
      const packet = buildGuardReviewPacket(
        root,
        config,
        loadedBaseline.baseline ?? new Set(),
        max_diff_chars,
        changed_only,
        requirement,
        base,
      );
      return jsonToolResult(
        { ...packet, status: packet.diffError ? 'fail' : 'needs-review' },
        Boolean(packet.diffError),
      );
    },
  );

  server.registerTool(
    'codapult_guard_check',
    {
      title: 'Guard Check',
      description:
        'Run active architecture rules and contract validation, returning structured findings and status. Use for a fast deterministic policy check: changed_only=true focuses on changed files and respects the baseline; false scans the full project. Omitted uses the scanner default. For a full audit that ignores baseline suppression, use codapult_guard_audit.',
      inputSchema: {
        root: rootSchema,
        changed_only: z
          .boolean()
          .optional()
          .describe(
            'Limit rule findings to changed files; true respects the baseline, false scans the full project.',
          ),
      },
    },
    ({ root: requestedRoot, changed_only }) => {
      const root = getGuardRoot(requestedRoot);
      const loaded = loadConfigSafely(root);
      if (loaded.error) return loaded.error;
      const config = loaded.config;
      if (!config) {
        return notConfiguredToolResult();
      }
      const loadedBaseline = loadBaselineSafely(root);
      if (loadedBaseline.error) return loadedBaseline.error;
      const report = scanGuard(root, config, {
        changedOnly: changed_only,
        baseline: loadedBaseline.baseline,
        includeArchitectureInsights: true,
      });
      const contractIssues = validateGuardPolicy(root, config);
      const errors = report.findings.filter((finding) => finding.severity === 'error').length;
      return jsonToolResult(
        {
          status: errors > 0 || contractIssues.length > 0 ? 'fail' : 'ok',
          outcome: classifyGuardOutcome({
            errors: errors + contractIssues.length,
            warnings: report.findings.filter((finding) => finding.severity === 'warning').length,
          }),
          contractIssues,
          ...report,
        },
        errors > 0 || contractIssues.length > 0,
      );
    },
  );

  server.registerTool(
    'codapult_guard_waivers',
    {
      title: 'Guard Waivers',
      description:
        'List or manage owner-attributed, time-limited exceptions tied to exact active finding fingerprints. Use list to inspect current waivers; add requires fingerprint, owner, expiry, and reason; renew/remove require waiver id and reason. Every mutation requires confirm=true and may be restricted by protected approval policy. Adding a waiver does not change the underlying rule.',
      inputSchema: {
        root: rootSchema,
        action: z
          .enum(['list', 'add', 'remove', 'renew'])
          .default('list')
          .describe('Operation to perform; list is read-only.'),
        fingerprint: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe('Exact finding fingerprint from a Guard report; required for add.'),
        id: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe('Existing waiver ID; required for remove and renew.'),
        owner: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe('Person or team responsible for the exception; required for add.'),
        reason: z
          .string()
          .trim()
          .min(1)
          .max(2000)
          .optional()
          .describe('Why the exception is needed; required for every mutation.'),
        expires_at: z.iso
          .datetime({ offset: true })
          .optional()
          .describe(
            'Expiry timestamp with timezone; required for add and optionally updates expiry on renew.',
          ),
        issue: z.url().optional().describe('Optional URL tracking the exception.'),
        confirm: z
          .boolean()
          .default(false)
          .describe('Must be true before adding, removing, or renewing a waiver.'),
      },
    },
    ({
      root: requestedRoot,
      action,
      fingerprint,
      id,
      owner,
      reason,
      expires_at,
      issue,
      confirm,
    }) => {
      const root = getGuardRoot(requestedRoot);
      let waivers: GuardWaiver[];
      try {
        waivers = loadGuardWaivers(root);
      } catch (error) {
        return waiverToolError(error);
      }
      if (action === 'list') return jsonToolResult({ status: 'ok', waivers });
      const loaded = loadConfigSafely(root);
      if (loaded.error) return loaded.error;
      if (
        loaded.config?.approval?.mode === 'protected' &&
        !loaded.config.approval.allowMcpApproval
      ) {
        return jsonToolResult(
          {
            status: 'approval-required',
            message:
              'Protected Guard policy requires waiver approval outside the MCP agent surface.',
            action,
          },
          true,
        );
      }
      if (
        loaded.config?.approval?.mode === 'protected' &&
        loaded.config.approval.requireDistinctActor &&
        !process.env.GUARD_APPROVER?.trim()
      ) {
        return jsonToolResult(
          {
            status: 'approval-required',
            message: 'Protected Guard policy requires GUARD_APPROVER for waiver changes.',
            action,
          },
          true,
        );
      }
      if (!confirm) return jsonToolResult({ status: 'needs-confirmation', action });
      if (!reason)
        return jsonToolResult({ status: 'invalid', message: 'reason is required.' }, true);
      if (action === 'add') {
        if (!fingerprint || !owner || !expires_at) {
          return jsonToolResult(
            { status: 'invalid', message: 'fingerprint, owner, and expires_at are required.' },
            true,
          );
        }
        const finding = scanGuard(root, loaded.config ?? { version: 1, rules: [] }, {
          waivers: [],
          includeArchitectureInsights: true,
        }).findings.find((candidate) => candidate.fingerprint === fingerprint);
        if (!finding) return jsonToolResult({ status: 'not-found', fingerprint }, true);
        const waiver: GuardWaiver = {
          id: `waiver-${randomUUID()}`,
          fingerprint,
          ruleId: finding.ruleId,
          owner,
          reason,
          createdAt: new Date().toISOString(),
          expiresAt: expires_at,
          ...(issue ? { issue } : {}),
          ...(process.env.GUARD_APPROVER?.trim()
            ? { approvedBy: process.env.GUARD_APPROVER.trim() }
            : {}),
        };
        try {
          updateGuardWaivers(root, {
            action,
            waiverId: waiver.id,
            waiver,
            reason,
            actor: process.env.GUARD_APPROVER,
            maxLifetimeDays: loaded.config?.waiverPolicy?.maxDays,
          });
        } catch (error) {
          return waiverToolError(error);
        }
        return jsonToolResult({ status: 'ok', action, waiver });
      }
      if (!id) return jsonToolResult({ status: 'invalid', message: 'id is required.' }, true);
      try {
        updateGuardWaivers(root, {
          action,
          waiverId: id,
          ...(expires_at ? { expiresAt: expires_at } : {}),
          reason,
          actor: process.env.GUARD_APPROVER,
          maxLifetimeDays: loaded.config?.waiverPolicy?.maxDays,
        });
      } catch (error) {
        return waiverToolError(error);
      }
      return jsonToolResult({ status: 'ok', action, id });
    },
  );

  server.registerTool(
    'codapult_guard_impact',
    {
      title: 'Guard Impact Analysis',
      description:
        'Trace the likely project impact of one or more file paths through the discovered dependency graph, including dependents, routes, capabilities, contracts, and graph paths. Use before changing a file to understand downstream areas to inspect. This is repository analysis, not a policy pass/fail check; returns structured impact details.',
      inputSchema: {
        root: rootSchema,
        files: z
          .array(z.string().trim().min(1))
          .min(1)
          .describe(
            'Repository-relative paths to analyze; provide every changed or planned file of interest.',
          ),
      },
    },
    ({ root: requestedRoot, files }) => {
      const root = getGuardRoot(requestedRoot);
      const model = discoverProject(root);
      const loaded = loadConfigSafely(root);
      if (loaded.error) return loaded.error;
      const impact = analyzeProjectImpact(model, files, loaded.config?.contracts ?? []);
      return jsonToolResult({
        status: 'ok',
        ...impact,
      });
    },
  );

  server.registerTool(
    'codapult_guard_explain',
    {
      title: 'Explain Guard Policy',
      description:
        'Look up one active Guard rule or contract by ID and return its definition, evidence, guidance, and suggested next steps. Use when a check reports a rule ID or when deciding how to comply. For a finding-specific explanation, inspect the finding from codapult_guard_check or codapult_guard_audit as well.',
      inputSchema: {
        root: rootSchema,
        id: z
          .string()
          .trim()
          .min(1)
          .describe('Exact rule or contract ID from Guard policy or a finding.'),
      },
    },
    ({ root: requestedRoot, id }) => {
      const root = getGuardRoot(requestedRoot);
      const loaded = loadConfigSafely(root);
      if (loaded.error) return loaded.error;
      const config = loaded.config;
      const item = [...(config?.rules ?? []), ...(config?.contracts ?? [])].find(
        (candidate) => candidate.id === id,
      );
      if (!item) return jsonToolResult({ status: 'not-found', id }, true);
      return jsonToolResult({
        status: 'ok',
        id,
        policy: item,
        evidence: 'evidence' in item ? (item.evidence ?? []) : [],
        guidance: 'guidance' in item ? (item.guidance ?? []) : [],
        nextSteps: [
          'Inspect the referenced project modules and current diff.',
          'Use an existing project boundary that satisfies the policy.',
          'If the policy is no longer correct, update it through a reviewed project change.',
        ],
      });
    },
  );
}
