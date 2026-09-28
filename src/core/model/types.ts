/** Shared domain vocabulary used by Guard core and its adapters. */
export type GuardSeverity = 'error' | 'warning' | 'info';

export type GuardRuleKind = 'forbidden-import' | 'client-forbidden-import';

export type GuardRuleStatus = 'active' | 'proposed';

export type GuardContractKind =
  'guidance' | 'import-boundary' | 'required-call' | 'package-boundary';

export type GuardBudgetMetric = 'lines' | 'bytes' | 'imports';

export type GuardToolMode = 'auto' | 'on' | 'off';

export interface GuardWaiver {
  id: string;
  fingerprint: string;
  ruleId: string;
  owner: string;
  reason: string;
  createdAt: string;
  expiresAt: string;
  issue?: string | undefined;
  approvedBy?: string | undefined;
}

export interface GuardWaiverDecision {
  at: string;
  action: 'add' | 'renew' | 'remove';
  waiverId: string;
  reason: string;
  actor?: string | undefined;
}

export type GuardApprovalMode = 'local' | 'protected';

export type GuardAdapterName =
  | 'dependency-graph'
  | 'security'
  | 'dependency-hygiene'
  | 'sast'
  | 'secret-scanning'
  | 'dependency-audit';

export type ProjectCheck = 'lint' | 'typecheck' | 'test' | 'build';
