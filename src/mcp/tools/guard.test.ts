import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../core/guard.js', () => ({
  buildArchitectureMemory: vi.fn(() => ({ fresh: true })),
  buildConventionsMemory: vi.fn(() => ({ fresh: true })),
  buildGeneratedGuardConfig: vi.fn(() => ({ version: 1, rules: [], contracts: [] })),
  buildGuardProposals: vi.fn(() => ({
    version: 1,
    generatedAt: 'now',
    rules: [],
    contracts: [],
    questions: [],
  })),
  buildGuardReviewPacket: vi.fn(() => ({ version: 1, redacted: false })),
  discoverProject: vi.fn(() => ({ version: 1, fresh: true })),
  discoverProjectWithMetrics: vi.fn(() => ({
    model: { version: 1, fresh: true },
    metrics: { durationMs: 1, files: 0, modules: 0, cacheAvailable: true },
  })),
  findGuardRoot: vi.fn(() => '/project'),
  fingerprintProjectModel: vi.fn(() => 'fingerprint'),
  GUARD_ARCHITECTURE_FILE: '.codapult/guard/architecture.json',
  GUARD_CONVENTIONS_FILE: '.codapult/guard/conventions.json',
  loadGuardAgentConfig: vi.fn(() => ({
    version: 1,
    tools: 'auto',
    tooling: {},
    completionGate: {
      enabled: true,
      maxIterations: 3,
      projectChecks: true,
      checks: ['lint', 'typecheck', 'test', 'build'],
    },
  })),
  loadBaseline: vi.fn(() => new Set()),
  loadGuardWaivers: vi.fn(() => []),
  loadGuardArtifact: vi.fn(() => ({ persisted: true })),
  loadGuardConfig: vi.fn(() => ({ version: 1, rules: [], contracts: [] })),
  loadProjectModel: vi.fn(() => ({ version: 1, persisted: true })),
  writeGuardProposals: vi.fn(),
  initializeGuard: vi.fn(() => ({ report: { findings: [] } })),
  GuardAlreadyInitializedError: class extends Error {},
  recordGuardProposalDecision: vi.fn(),
  applyGuardProposalDecision: vi.fn(),
  validateGuardProposalApproval: vi.fn(() => undefined),
  writeGuardConfig: vi.fn(),
  writeProjectState: vi.fn(() => 'working-tree'),
  loadGuardProposals: vi.fn(),
  getPendingGuardProposals: vi.fn(() => []),
  getGuardProposalFreshness: vi.fn(() => 'unknown'),
  scanGuard: vi.fn(() => ({ findings: [], suppressed: 0, scannedFiles: 0 })),
  validateGuardContracts: vi.fn(() => []),
  validateGuardBudgets: vi.fn(() => []),
  validateGuardPolicy: vi.fn(() => []),
  classifyGuardOutcome: vi.fn(() => 'pass'),
}));

vi.mock('../../core/verification/verify.js', () => ({
  runGuardVerification: vi.fn(() => ({
    status: 'ok',
    outcome: 'pass',
    checks: {},
    adapters: {},
    architecture: { findings: [] },
    requirement: { status: 'delegated-to-review', provided: true, message: 'review' },
  })),
}));

const {
  discoverProjectWithMetrics,
  loadProjectModel,
  buildGuardReviewPacket,
  loadGuardProposals,
  getPendingGuardProposals,
  getGuardProposalFreshness,
  loadGuardConfig,
  loadGuardWaivers,
} = await import('../../core/guard.js');
const { runGuardVerification } = await import('../../core/verification/verify.js');
const { registerGuardTools } = await import('./guard.js');

interface ToolRegistration {
  name: string;
  handler: (args: Record<string, unknown>) => { content: { type: string; text: string }[] };
}

interface ContextResponse {
  observations: { status: string };
  proposals: {
    status: string;
    requiresApproval: boolean;
    pendingRules: { id: string; status: string }[];
  };
  policy: { rules: unknown[] };
  verification: { status: string; findings: unknown[] | null };
}

function createMockServer(): { registerTool: ReturnType<typeof vi.fn>; tools: ToolRegistration[] } {
  const tools: ToolRegistration[] = [];
  const registerTool = vi.fn(
    (name: string, _options: unknown, handler: ToolRegistration['handler']) => {
      tools.push({ name, handler });
    },
  );
  return { registerTool, tools };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getPendingGuardProposals).mockReturnValue([]);
});

describe('registerGuardTools', () => {
  it('registers all Guard MCP tools', () => {
    const server = createMockServer();
    registerGuardTools(server as never);

    expect(server.tools.map((tool) => tool.name)).toEqual([
      'codapult_guard_analyze',
      'codapult_guard_next_action',
      'codapult_guard_context',
      'codapult_guard_propose',
      'codapult_guard_init',
      'codapult_guard_proposal_decide',
      'codapult_guard_verify',
      'codapult_guard_governance',
      'codapult_guard_audit',
      'codapult_guard_review',
      'codapult_guard_check',
      'codapult_guard_waivers',
      'codapult_guard_impact',
      'codapult_guard_explain',
    ]);
  });

  it('refreshes context by default instead of returning a stale persisted snapshot', () => {
    const server = createMockServer();
    registerGuardTools(server as never);
    const handler = server.tools.find((tool) => tool.name === 'codapult_guard_context')!.handler;

    const result = handler({ refresh: true });

    expect(discoverProjectWithMetrics).toHaveBeenCalledWith('/project', { persistCache: true });
    expect(loadProjectModel).not.toHaveBeenCalled();
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      tools: 'auto',
      observations: { status: 'observed-only' },
      proposals: {
        status: 'none',
        requiresApproval: false,
        pendingRules: [],
        pendingContracts: [],
      },
      policy: {
        status: 'active',
        rules: [],
        contracts: [],
        baseline: { status: 'active', count: 0 },
        waivers: [],
      },
      verification: {
        status: 'not-run',
        findings: null,
        next: 'codapult_guard_check',
      },
    });
  });

  it('marks recurring observations as unapproved until a proposal is explicitly approved', () => {
    vi.mocked(loadGuardProposals).mockReturnValue({
      version: 1,
      generatedAt: 'now',
      proposalId: 'proposal-id',
      rules: [
        {
          id: 'observed-rule',
          description: 'Observed rule',
          severity: 'warning',
          kind: 'forbidden-import',
          patterns: ['legacy-db'],
          status: 'proposed',
        },
      ],
      contracts: [],
      questions: ['Which module is canonical?'],
    });
    vi.mocked(getGuardProposalFreshness).mockReturnValue('current');
    vi.mocked(getPendingGuardProposals).mockReturnValue([{ id: 'observed-rule', type: 'rule' }]);
    const server = createMockServer();
    registerGuardTools(server as never);
    const handler = server.tools.find((tool) => tool.name === 'codapult_guard_context')!.handler;

    const context = JSON.parse(handler({ refresh: true }).content[0].text) as ContextResponse;

    expect(context.observations.status).toBe('observed-only');
    expect(context.proposals).toMatchObject({
      status: 'pending-approval',
      requiresApproval: true,
      pendingRules: [{ id: 'observed-rule', status: 'proposed' }],
    });
    expect(context.policy.rules).toEqual([]);
    expect(context.verification).toMatchObject({
      status: 'not-run',
      findings: null,
    });
  });

  it('does not present decided proposal history as pending policy', () => {
    vi.mocked(loadGuardProposals).mockReturnValue({
      version: 1,
      generatedAt: 'now',
      proposalId: 'proposal-id',
      rules: [
        {
          id: 'decided-rule',
          description: 'Decided rule',
          severity: 'error',
          kind: 'forbidden-import',
          patterns: ['legacy-db'],
          status: 'proposed',
        },
      ],
      contracts: [],
      questions: [],
    });
    vi.mocked(getGuardProposalFreshness).mockReturnValue('current');
    vi.mocked(getPendingGuardProposals).mockReturnValue([]);
    const server = createMockServer();
    registerGuardTools(server as never);
    const handler = server.tools.find((tool) => tool.name === 'codapult_guard_context')!.handler;

    const context = JSON.parse(handler({ refresh: true }).content[0].text) as ContextResponse;

    expect(context.proposals).toMatchObject({
      status: 'decided',
      requiresApproval: false,
      pendingRules: [],
    });
  });

  it('returns a structured error when waiver state is malformed', () => {
    vi.mocked(loadGuardWaivers).mockImplementation(() => {
      throw new Error('Invalid .codapult/guard/waivers.json');
    });
    const server = createMockServer();
    registerGuardTools(server as never);
    const handler = server.tools.find((tool) => tool.name === 'codapult_guard_context')!.handler;

    const result = handler({ refresh: true });
    const payload = JSON.parse(result.content[0].text) as {
      errorCode?: string;
      hint?: string;
    };

    expect(result).toHaveProperty('isError', true);
    expect(payload).toMatchObject({
      errorCode: 'GUARD_CONFIG_INVALID',
      hint: 'Repair waivers.json, then run codapult-guard doctor.',
    });
  });

  it('does not ask for policy review after the current proposal was decided', () => {
    vi.mocked(loadGuardProposals).mockReturnValue({
      version: 1,
      generatedAt: 'now',
      proposalId: 'proposal-id',
      contentFingerprint: 'content-hash',
      revision: 1,
      rules: [
        {
          id: 'decided-rule',
          description: 'Rule',
          severity: 'error',
          kind: 'forbidden-import',
          patterns: ['db'],
          status: 'proposed',
        },
      ],
      contracts: [],
      questions: [],
      decisions: [
        {
          id: 'decided-rule',
          type: 'rule',
          decision: 'approved',
          decidedAt: '2026-09-23T00:00:00.000Z',
          proposalId: 'proposal-id',
          proposalFingerprint: 'content-hash',
          revision: 1,
        },
      ],
    });
    vi.mocked(getGuardProposalFreshness).mockReturnValue('current');
    const server = createMockServer();
    registerGuardTools(server as never);
    const handler = server.tools.find(
      (tool) => tool.name === 'codapult_guard_next_action',
    )!.handler;

    expect(JSON.parse(handler({}).content[0].text)).toMatchObject({
      status: 'ready-for-verification',
      action: 'verify',
    });
  });

  it('allows an agent to request the persisted snapshot explicitly', () => {
    const server = createMockServer();
    registerGuardTools(server as never);
    const handler = server.tools.find((tool) => tool.name === 'codapult_guard_context')!.handler;

    handler({ refresh: false });

    expect(loadProjectModel).toHaveBeenCalledWith('/project');
  });

  it('passes an explicit requirement into semantic review preparation', () => {
    const server = createMockServer();
    registerGuardTools(server as never);
    const handler = server.tools.find((tool) => tool.name === 'codapult_guard_review')!.handler;

    handler({ changed_only: true, max_diff_chars: 1000, requirement: 'Add an audit event.' });

    expect(buildGuardReviewPacket).toHaveBeenCalledWith(
      '/project',
      expect.anything(),
      expect.anything(),
      1000,
      true,
      'Add an audit event.',
      undefined,
    );
  });

  it('lets the agent config choose project checks unless explicitly overridden', () => {
    const server = createMockServer();
    registerGuardTools(server as never);
    const handler = server.tools.find((tool) => tool.name === 'codapult_guard_verify')!.handler;

    handler({});
    expect(runGuardVerification).toHaveBeenCalledWith('/project', {});

    handler({ project_checks: false });
    expect(runGuardVerification).toHaveBeenLastCalledWith(
      '/project',
      expect.objectContaining({
        projectChecks: false,
      }),
    );
  });

  it('passes the protected policy ref through MCP verification', () => {
    const server = createMockServer();
    registerGuardTools(server as never);
    const handler = server.tools.find((tool) => tool.name === 'codapult_guard_verify')!.handler;

    handler({ policy_base: 'origin/main', fail_on_policy_change: true });

    expect(runGuardVerification).toHaveBeenLastCalledWith(
      '/project',
      expect.objectContaining({
        policyBase: 'origin/main',
        failOnPolicyChange: true,
      }),
    );
  });

  it('requires confirmation before initializing Guard through MCP', () => {
    const server = createMockServer();
    registerGuardTools(server as never);
    const handler = server.tools.find((tool) => tool.name === 'codapult_guard_init')!.handler;

    const result = handler({ confirm: false, force: false });

    expect(JSON.parse(result.content[0].text)).toMatchObject({ status: 'needs-confirmation' });
  });

  it('does not allow MCP to approve policy in protected mode', () => {
    vi.mocked(loadGuardConfig).mockReturnValue({
      version: 1,
      rules: [],
      approval: { mode: 'protected', allowMcpApproval: false, requireDistinctActor: true },
    });
    vi.mocked(loadGuardProposals).mockReturnValue({
      version: 1,
      generatedAt: 'now',
      proposalId: 'proposal-id',
      projectFingerprint: 'fingerprint',
      contentFingerprint: 'content',
      rules: [
        {
          id: 'rule',
          description: 'Rule',
          severity: 'error',
          kind: 'forbidden-import',
          patterns: ['db'],
          status: 'proposed',
        },
      ],
      contracts: [],
      questions: [],
    });
    vi.mocked(getGuardProposalFreshness).mockReturnValue('current');

    const server = createMockServer();
    registerGuardTools(server as never);
    const handler = server.tools.find(
      (tool) => tool.name === 'codapult_guard_proposal_decide',
    )!.handler;
    const result = handler({ ids: ['rule'], decision: 'approved', confirm: true });

    expect(JSON.parse(result.content[0].text)).toMatchObject({ status: 'approval-required' });
  });
});
