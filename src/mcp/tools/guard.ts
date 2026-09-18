import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  buildArchitectureMemory,
  buildConventionsMemory,
  buildGeneratedGuardConfig,
  buildGuardProposals,
  buildGuardReviewPacket,
  discoverProject,
  discoverProjectWithMetrics,
  findGuardRoot,
  GUARD_ARCHITECTURE_FILE,
  GUARD_CONVENTIONS_FILE,
  loadBaseline,
  loadGuardArtifact,
  loadGuardConfig,
  loadGuardAgentConfig,
  loadGuardProposals,
  getGuardProposalFreshness,
  loadProjectModel,
  writeGuardProposals,
  initializeGuard,
  GuardAlreadyInitializedError,
  recordGuardProposalDecision,
  writeGuardConfig,
  scanGuard,
  validateGuardContracts,
  classifyGuardOutcome,
} from '../../core/guard.js';
import { analyzeProjectImpact } from '../../core/analysis/impact.js';
import { z } from 'zod';
import { runGuardVerification } from '../../core/verification/verify.js';

const rootSchema = z.string().trim().min(1).optional().describe('Project path or workspace root.');

function getGuardRoot(root?: string): string {
  return root ? findGuardRoot(root) : findGuardRoot();
}

function jsonToolResult(
  value: unknown,
  isError = false,
): { content: { type: 'text'; text: string }[]; isError?: boolean } {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

export function registerGuardTools(server: McpServer): void {
  server.registerTool(
    'codapult_guard_context',
    {
      title: 'Guard Context',
      description:
        'Read the discovered project model, architecture insights, and local rules used by Codapult Guard. Works before init by discovering the project on demand.',
      inputSchema: {
        root: rootSchema,
        refresh: z
          .boolean()
          .default(true)
          .describe('Rediscover the working tree instead of reading the persisted snapshot.'),
      },
    },
    ({ root: requestedRoot, refresh }) => {
      const root = getGuardRoot(requestedRoot);
      const config = loadGuardConfig(root);
      const agentConfig = loadGuardAgentConfig(root);
      const discovery = refresh
        ? discoverProjectWithMetrics(root, { persistCache: true })
        : { model: loadProjectModel(root) ?? discoverProject(root), metrics: undefined };
      const project = discovery.model;
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
                rules: config?.rules ?? [],
                contracts: config?.contracts ?? [],
                architecture: refresh
                  ? buildArchitectureMemory(project)
                  : (loadGuardArtifact(root, GUARD_ARCHITECTURE_FILE) ??
                    buildArchitectureMemory(project)),
                conventions: refresh
                  ? buildConventionsMemory(project)
                  : (loadGuardArtifact(root, GUARD_CONVENTIONS_FILE) ??
                    buildConventionsMemory(project)),
                project,
                discovery: discovery.metrics,
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
        'Generate evidence-based rule and contract proposals for an AI agent. Proposals are never activated automatically.',
      inputSchema: {
        root: rootSchema,
        persist: z.boolean().default(false).describe('Persist proposals.json in the project.'),
        confirm: z.boolean().default(false).describe('Required when persist is true.'),
      },
    },
    ({ root: requestedRoot, persist, confirm }) => {
      const root = getGuardRoot(requestedRoot);
      if (persist && !confirm)
        return jsonToolResult({ status: 'needs-confirmation', persist: true });
      const project = discoverProject(root);
      const config = loadGuardConfig(root) ?? buildGeneratedGuardConfig(project);
      const proposals = buildGuardProposals(project, config);
      const previous = loadGuardProposals(root);
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
        'Create Guard artifacts after explicit confirmation; existing baselines are protected by default.',
      inputSchema: {
        root: rootSchema,
        confirm: z.boolean().default(false).describe('Required before writing Guard artifacts.'),
        force: z
          .boolean()
          .default(false)
          .describe('Replace existing Guard state; requires confirm.'),
      },
    },
    ({ root: requestedRoot, confirm, force }) => {
      const root = getGuardRoot(requestedRoot);
      if (!confirm) return jsonToolResult({ status: 'needs-confirmation', root, force });
      try {
        const result = initializeGuard(root, { force });
        return jsonToolResult({ status: 'ok', root, report: result.report });
      } catch (error) {
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
        'Approve or reject current evidence-backed proposals; stale proposals cannot be activated.',
      inputSchema: {
        root: rootSchema,
        ids: z.array(z.string().trim().min(1)).min(1),
        decision: z.enum(['approved', 'rejected']),
        confirm: z.boolean().default(false).describe('Required before changing Guard state.'),
      },
    },
    ({ root: requestedRoot, ids, decision, confirm }) => {
      const root = getGuardRoot(requestedRoot);
      const proposals = loadGuardProposals(root);
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
      if (!confirm) return jsonToolResult({ status: 'needs-confirmation', decision, ids });
      if (decision === 'approved') {
        const config = loadGuardConfig(root) ?? { version: 1 as const, rules: [], contracts: [] };
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
        writeGuardConfig(root, { version: 1, rules: nextRules, contracts: nextContracts });
      }
      recordGuardProposalDecision(
        root,
        selected.map((item) => ({
          id: item.id,
          type: 'statement' in item ? ('contract' as const) : ('rule' as const),
          decision,
        })),
      );
      return jsonToolResult({ status: 'ok', root, decision, ids });
    },
  );

  server.registerTool(
    'codapult_guard_verify',
    {
      title: 'Guard Verify',
      description:
        'Run project checks, production build, and architecture regression checks as one verification gate.',
      inputSchema: {
        root: rootSchema,
        checks: z
          .array(z.enum(['lint', 'typecheck', 'test', 'build']))
          .optional()
          .describe('Checks to run; defaults to lint, typecheck, test, and build.'),
        changed_only: z.boolean().optional(),
        requirement: z.string().trim().min(1).max(20_000).optional(),
        tools: z
          .enum(['auto', 'on', 'off'])
          .optional()
          .describe('External tools mode; defaults to agent.json.'),
        strict: z.boolean().optional(),
        project_checks: z
          .boolean()
          .optional()
          .describe('Override completionGate.projectChecks for this invocation.'),
        iteration: z.number().int().positive().default(1),
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
      iteration,
    }) => {
      const root = getGuardRoot(requestedRoot);
      const result = runGuardVerification(root, {
        checks,
        changedOnly: changed_only,
        requirement,
        tools,
        strict,
        projectChecks: project_checks,
      });
      const completionGate = loadGuardAgentConfig(root).completionGate;
      return jsonToolResult(
        {
          ...result,
          completionGate: {
            ...completionGate,
            iteration,
            canRetry: result.status === 'fail' && iteration < completionGate.maxIterations,
          },
        },
        result.status === 'fail',
      );
    },
  );

  server.registerTool(
    'codapult_guard_audit',
    {
      title: 'Guard Audit',
      description:
        'Run a full Guard audit, ignoring baseline suppression and validating contracts.',
      inputSchema: { root: rootSchema },
    },
    ({ root: requestedRoot }) => {
      const root = getGuardRoot(requestedRoot);
      const config = loadGuardConfig(root);
      if (!config) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ configured: false, outcome: 'not-configured' }, null, 2),
            },
          ],
          isError: true,
        };
      }
      const report = scanGuard(root, config, { includeArchitectureInsights: true });
      const contractIssues = validateGuardContracts(root, config.contracts ?? []);
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
        'Prepare a bounded semantic-review packet containing the current diff, project model, contracts, and deterministic findings for an AI reviewer.',
      inputSchema: {
        root: rootSchema,
        changed_only: z.boolean().default(true),
        max_diff_chars: z.number().int().positive().max(500_000).default(120_000),
        requirement: z.string().trim().min(1).max(20_000).optional(),
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
      const config = loadGuardConfig(root);
      if (!config) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ configured: false, outcome: 'not-configured' }, null, 2),
            },
          ],
          isError: true,
        };
      }
      const packet = buildGuardReviewPacket(
        root,
        config,
        changed_only ? loadBaseline(root) : new Set(),
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
      description: 'Check project architecture rules and return structured new violations.',
      inputSchema: { root: rootSchema, changed_only: z.boolean().optional() },
    },
    ({ root: requestedRoot, changed_only }) => {
      const root = getGuardRoot(requestedRoot);
      const config = loadGuardConfig(root);
      if (!config) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ configured: false, outcome: 'not-configured' }, null, 2),
            },
          ],
          isError: true,
        };
      }
      const report = scanGuard(root, config, {
        changedOnly: changed_only,
        baseline: loadBaseline(root),
        includeArchitectureInsights: true,
      });
      const contractIssues = validateGuardContracts(root, config.contracts ?? []);
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
    'codapult_guard_impact',
    {
      title: 'Guard Impact Analysis',
      description:
        'Explain the project impact of one or more changed files using the discovered dependency graph, routes, capabilities, and contracts.',
      inputSchema: {
        root: rootSchema,
        files: z.array(z.string().trim().min(1)).min(1),
      },
    },
    ({ root: requestedRoot, files }) => {
      const root = getGuardRoot(requestedRoot);
      const model = discoverProject(root);
      const impact = analyzeProjectImpact(model, files, loadGuardConfig(root)?.contracts ?? []);
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
      description: 'Explain a Guard rule or contract with its evidence and applicable scope.',
      inputSchema: {
        root: rootSchema,
        id: z.string().trim().min(1),
      },
    },
    ({ root: requestedRoot, id }) => {
      const root = getGuardRoot(requestedRoot);
      const config = loadGuardConfig(root);
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
