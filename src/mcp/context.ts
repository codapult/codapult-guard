import type { ProjectModel } from '../core/discovery/discovery.js';
import {
  getGuardProposalFreshness,
  getPendingGuardProposals,
  type GuardConfig,
  type GuardProposalFile,
  type GuardWaiver,
} from '../core/guard.js';

export interface GuardDiscoveryMetrics {
  durationMs: number;
  files: number;
  modules: number;
  changedFiles: number;
  reusedModules: number;
  cacheHit: boolean;
  cacheAvailable: boolean;
}

export interface GuardContextState {
  observations: {
    status: 'observed-only';
    project: ProjectModel;
    architecture: Record<string, unknown>;
    conventions: Record<string, unknown>;
    discovery: GuardDiscoveryMetrics | undefined;
  };
  proposals: {
    status: 'not-configured' | 'none' | 'pending-approval' | 'stale' | 'decided';
    requiresApproval: boolean;
    freshness: 'current' | 'stale' | 'unknown' | 'none';
    proposalId?: string | undefined;
    generatedBy?: string | undefined;
    pendingRules: GuardConfig['rules'];
    pendingContracts: NonNullable<GuardConfig['contracts']>;
    questions: string[];
    pending: ReturnType<typeof getPendingGuardProposals>;
  };
  policy: {
    status: 'not-configured' | 'active';
    rules: GuardConfig['rules'];
    contracts: NonNullable<GuardConfig['contracts']>;
    baseline: { status: 'not-configured' | 'active'; count: number };
    waivers: GuardWaiver[];
  };
  verification: {
    status: 'not-run';
    findings: null;
    message: string;
    next: 'codapult_guard_init' | 'codapult_guard_check';
  };
}

export function buildGuardContextState(
  project: ProjectModel,
  discovery: GuardDiscoveryMetrics | undefined,
  architecture: Record<string, unknown>,
  conventions: Record<string, unknown>,
  config: GuardConfig | undefined,
  proposals: GuardProposalFile | undefined,
  baseline: Set<string>,
  waivers: GuardWaiver[],
): GuardContextState {
  const pending = getPendingGuardProposals(proposals);
  const freshness = proposals ? getGuardProposalFreshness(project, proposals) : 'none';
  const pendingRuleIds = new Set(
    pending.filter((item) => item.type === 'rule').map((item) => item.id),
  );
  const pendingContractIds = new Set(
    pending.filter((item) => item.type === 'contract').map((item) => item.id),
  );
  const pendingRules =
    proposals?.rules.filter((rule) => rule.status === 'proposed' && pendingRuleIds.has(rule.id)) ??
    [];
  const pendingContracts =
    proposals?.contracts.filter(
      (contract) => contract.status === 'proposed' && pendingContractIds.has(contract.id),
    ) ?? [];
  const proposalStatus =
    config === undefined
      ? 'not-configured'
      : proposals === undefined
        ? 'none'
        : freshness === 'stale'
          ? 'stale'
          : pending.length > 0
            ? 'pending-approval'
            : 'decided';

  return {
    observations: { status: 'observed-only', project, architecture, conventions, discovery },
    proposals: {
      status: proposalStatus,
      requiresApproval: pending.length > 0 || freshness === 'stale',
      freshness,
      ...(proposals?.proposalId ? { proposalId: proposals.proposalId } : {}),
      ...(proposals?.generatedBy ? { generatedBy: proposals.generatedBy } : {}),
      pendingRules,
      pendingContracts,
      questions: proposals?.questions ?? [],
      pending,
    },
    policy: {
      status: config === undefined ? 'not-configured' : 'active',
      rules: config?.rules.filter((rule) => rule.status === 'active') ?? [],
      contracts: config?.contracts?.filter((contract) => contract.status === 'active') ?? [],
      baseline: {
        status: config === undefined ? 'not-configured' : 'active',
        count: baseline.size,
      },
      waivers,
    },
    verification: {
      status: 'not-run',
      findings: null,
      message: 'Context contains facts and policy state; it does not run verification.',
      next: config === undefined ? 'codapult_guard_init' : 'codapult_guard_check',
    },
  };
}
