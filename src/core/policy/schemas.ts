import { z } from 'zod';

const severity = z.enum(['error', 'warning', 'info']);
const status = z.enum(['active', 'proposed']);

export const guardRuleSchema = z.object({
  id: z.string(),
  description: z.string(),
  severity,
  kind: z.enum(['forbidden-import', 'client-forbidden-import']),
  patterns: z.array(z.string()),
  files: z.array(z.string()).optional(),
  status: status.optional(),
  confidence: z.enum(['high', 'medium', 'low']).optional(),
  evidence: z.array(z.string()).optional(),
});

export const guardContractSchema = z.object({
  id: z.string(),
  statement: z.string(),
  kind: z.enum(['guidance', 'import-boundary', 'required-call']).optional(),
  severity: severity.optional(),
  scope: z.array(z.string()).optional(),
  entrypoints: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  guidance: z.array(z.string()).optional(),
  references: z.array(z.string()).optional(),
  mustImport: z.array(z.string()).optional(),
  mustNotImport: z.array(z.string()).optional(),
  mustCall: z.array(z.string()).optional(),
  status: status.optional(),
  confidence: z.enum(['high', 'medium', 'low']).optional(),
  evidence: z.array(z.string()).optional(),
});

export const guardConfigSchema = z.object({
  version: z.literal(1),
  rules: z.array(guardRuleSchema),
  contracts: z.array(guardContractSchema).optional(),
});

export const guardContractsFileSchema = z.object({
  version: z.literal(1),
  contracts: z.array(guardContractSchema),
});

export const guardProposalDecisionSchema = z.object({
  id: z.string(),
  type: z.enum(['rule', 'contract']),
  decision: z.enum(['approved', 'rejected']),
  decidedAt: z.string(),
  proposalId: z.string().optional(),
  proposalFingerprint: z.string().optional(),
  revision: z.number().optional(),
});

export const guardProposalSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string(),
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
  tooling: z.record(z.string(), z.object({ script: z.string(), enabled: z.boolean() })).default({}),
  completionGate: z.object({
    enabled: z.boolean(),
    maxIterations: z.number().int().min(1).max(10),
    projectChecks: z.boolean(),
    checks: z.array(z.enum(['lint', 'typecheck', 'test', 'build'])),
  }),
});
