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
  loadGuardArtifact: vi.fn(() => ({ persisted: true })),
  loadGuardConfig: vi.fn(() => ({ version: 1, rules: [], contracts: [] })),
  loadProjectModel: vi.fn(() => ({ version: 1, persisted: true })),
  writeGuardProposals: vi.fn(),
  initializeGuard: vi.fn(() => ({ report: { findings: [] } })),
  GuardAlreadyInitializedError: class extends Error {},
  recordGuardProposalDecision: vi.fn(),
  writeGuardConfig: vi.fn(),
  loadGuardProposals: vi.fn(),
  getGuardProposalFreshness: vi.fn(() => 'unknown'),
  scanGuard: vi.fn(() => ({ findings: [], suppressed: 0, scannedFiles: 0 })),
  validateGuardContracts: vi.fn(() => []),
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

const { discoverProjectWithMetrics, loadProjectModel, buildGuardReviewPacket } =
  await import('../../core/guard.js');
const { runGuardVerification } = await import('../../core/verification/verify.js');
const { registerGuardTools } = await import('./guard.js');

interface ToolRegistration {
  name: string;
  handler: (args: Record<string, unknown>) => { content: { type: string; text: string }[] };
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

beforeEach(() => vi.clearAllMocks());

describe('registerGuardTools', () => {
  it('registers all Guard MCP tools', () => {
    const server = createMockServer();
    registerGuardTools(server as never);

    expect(server.tools.map((tool) => tool.name)).toEqual([
      'codapult_guard_context',
      'codapult_guard_propose',
      'codapult_guard_init',
      'codapult_guard_proposal_decide',
      'codapult_guard_verify',
      'codapult_guard_audit',
      'codapult_guard_review',
      'codapult_guard_check',
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
    expect(JSON.parse(result.content[0].text)).toMatchObject({ tools: 'auto' });
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
    expect(runGuardVerification).toHaveBeenCalledWith(
      '/project',
      expect.objectContaining({
        projectChecks: undefined,
      }),
    );

    handler({ project_checks: false });
    expect(runGuardVerification).toHaveBeenLastCalledWith(
      '/project',
      expect.objectContaining({
        projectChecks: false,
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
});
