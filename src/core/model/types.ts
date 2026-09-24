/** Shared domain vocabulary used by Guard core and its adapters. */
export type GuardSeverity = 'error' | 'warning' | 'info';

export type GuardRuleKind = 'forbidden-import' | 'client-forbidden-import';

export type GuardRuleStatus = 'active' | 'proposed';

export type GuardContractKind =
  'guidance' | 'import-boundary' | 'required-call' | 'package-boundary';

export type GuardBudgetMetric = 'lines' | 'bytes' | 'imports';

export type GuardToolMode = 'auto' | 'on' | 'off';

export type GuardAdapterName = 'dependency-graph' | 'security' | 'dependency-hygiene';

export type ProjectCheck = 'lint' | 'typecheck' | 'test' | 'build';
