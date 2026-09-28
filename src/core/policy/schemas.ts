import { z } from 'zod';

const severity = z.enum(['error', 'warning', 'info']);
const status = z.enum(['active', 'proposed']);

export const guardWaiverSchema = z.object({
  id: z.string().trim().min(1),
  fingerprint: z.string().trim().min(1),
  ruleId: z.string().trim().min(1),
  owner: z.string().trim().min(1),
  reason: z.string().trim().min(1),
  createdAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
  issue: z.url().optional(),
  approvedBy: z.string().trim().min(1).optional(),
});

export const guardWaiverDecisionSchema = z.object({
  at: z.iso.datetime({ offset: true }),
  action: z.enum(['add', 'renew', 'remove']),
  waiverId: z.string().trim().min(1),
  reason: z.string().trim().min(1),
  actor: z.string().trim().min(1).optional(),
});

export const guardWaiversFileSchema = z.object({
  version: z.literal(1),
  waivers: z.array(guardWaiverSchema),
  decisions: z.array(guardWaiverDecisionSchema),
});

export const guardBudgetSchema = z.object({
  id: z.string().trim().min(1),
  description: z.string().trim().min(1),
  metric: z.enum(['lines', 'bytes', 'imports']),
  scope: z.array(z.string().trim().min(1)).min(1),
  limit: z.number().int().positive(),
  severity,
  reason: z.string().trim().min(1),
  status: status.optional(),
  evidence: z.array(z.string()).optional(),
});

export const guardRuleSchema = z.object({
  id: z.string().trim().min(1),
  description: z.string().trim().min(1),
  severity,
  kind: z.enum(['forbidden-import', 'client-forbidden-import']),
  patterns: z.array(z.string().trim().min(1)).min(1),
  files: z.array(z.string().trim().min(1)).optional(),
  status: status.optional(),
  confidence: z.enum(['high', 'medium', 'low']).optional(),
  evidence: z.array(z.string()).optional(),
});

export const guardContractSchema = z.object({
  id: z.string().trim().min(1),
  statement: z.string().trim().min(1),
  kind: z.enum(['guidance', 'import-boundary', 'required-call', 'package-boundary']).optional(),
  severity: severity.optional(),
  scope: z.array(z.string().trim().min(1)).optional(),
  entrypoints: z.array(z.string().trim().min(1)).optional(),
  exclude: z.array(z.string().trim().min(1)).optional(),
  guidance: z.array(z.string().trim().min(1)).optional(),
  references: z.array(z.string().trim().min(1)).optional(),
  mustImport: z.array(z.string().trim().min(1)).optional(),
  mustNotImport: z.array(z.string().trim().min(1)).optional(),
  mustCall: z.array(z.string().trim().min(1)).optional(),
  fromPackages: z.array(z.string().trim().min(1)).optional(),
  mustNotImportPackages: z.array(z.string().trim().min(1)).optional(),
  status: status.optional(),
  confidence: z.enum(['high', 'medium', 'low']).optional(),
  evidence: z.array(z.string()).optional(),
});

export const guardConfigSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative().optional(),
  contentFingerprint: z.string().optional(),
  rules: z.array(guardRuleSchema),
  contracts: z.array(guardContractSchema).optional(),
  budgets: z.array(guardBudgetSchema).optional(),
  approval: z
    .object({
      mode: z.enum(['local', 'protected']),
      allowMcpApproval: z.boolean(),
      requireDistinctActor: z.boolean(),
    })
    .optional(),
  waiverPolicy: z
    .object({
      warningDays: z.number().int().min(0).max(3650),
      maxDays: z.number().int().positive().max(3650).optional(),
    })
    .refine((policy) => policy.maxDays === undefined || policy.maxDays >= policy.warningDays, {
      message: 'waiverPolicy.maxDays must be greater than or equal to warningDays',
      path: ['maxDays'],
    })
    .optional(),
});

export const guardContractsFileSchema = z.object({
  version: z.literal(1),
  contracts: z.array(guardContractSchema),
});

export const guardProposalDecisionSchema = z.object({
  id: z.string().trim().min(1),
  type: z.enum(['rule', 'contract']),
  decision: z.enum(['approved', 'rejected']),
  decidedAt: z.string(),
  proposalId: z.string().optional(),
  proposalFingerprint: z.string().optional(),
  revision: z.number().optional(),
  source: z.enum(['cli', 'mcp', 'external']).optional(),
  actor: z.string().optional(),
  commit: z.string().optional(),
});

export const guardProposalSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string(),
  generatedBy: z.string().trim().min(1).optional(),
  proposalId: z.string().optional(),
  projectFingerprint: z.string().optional(),
  revision: z.number().int().positive().optional(),
  contentFingerprint: z.string().optional(),
  rules: z.array(guardRuleSchema),
  contracts: z.array(guardContractSchema),
  questions: z.array(z.string()),
  decisions: z.array(guardProposalDecisionSchema).optional(),
});

export const guardAgentConfigSchema = z.object({
  version: z.literal(1),
  tools: z.enum(['auto', 'on', 'off']),
  tooling: z
    .record(
      z.string().trim().min(1),
      z.object({ script: z.string().trim().min(1), enabled: z.boolean() }),
    )
    .default({}),
  completionGate: z.object({
    enabled: z.boolean(),
    maxIterations: z.number().int().min(1).max(10),
    projectChecks: z.boolean(),
    checks: z.array(z.enum(['lint', 'typecheck', 'test', 'build'])),
  }),
});
