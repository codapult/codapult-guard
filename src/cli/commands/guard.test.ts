import { describe, expect, it, vi } from 'vitest';
import { config } from '../../core/config.js';

vi.mock('node:fs', () => ({ existsSync: vi.fn(() => true) }));
vi.mock('../../core/guard.js', () => ({
  GUARD_BASELINE_FILE: `.${config.appName}/guard/baseline.json`,
  GUARD_BASELINE_META_FILE: `.${config.appName}/guard/baseline-meta.json`,
  GUARD_RULES_FILE: `.${config.appName}/guard/rules.json`,
  GUARD_PROJECT_FILE: `.${config.appName}/guard/project.json`,
  GUARD_HISTORY_DIR: `.${config.appName}/guard/history`,
  GUARD_ARCHITECTURE_FILE: `.${config.appName}/guard/architecture.json`,
  GUARD_CONVENTIONS_FILE: `.${config.appName}/guard/conventions.json`,
  GUARD_AGENT_FILE: `.${config.appName}/guard/agent.json`,
  GUARD_CONTRACTS_FILE: `.${config.appName}/guard/contracts.json`,
  GUARD_PROPOSALS_FILE: `.${config.appName}/guard/proposals.json`,
  findGuardRoot: vi.fn(() => '/project'),
  discoverProject: vi.fn(() => ({ files: [], modules: [], insights: { cycles: [] } })),
  discoverProjectWithMetrics: vi.fn(() => ({
    model: { files: [], modules: [], insights: { cycles: [] } },
    metrics: { durationMs: 1, files: 0, modules: 0, cacheAvailable: false },
  })),
  initializeGuard: vi.fn(() => ({
    config: { rules: [{}], contracts: [] },
    report: { scannedFiles: 3 },
  })),
  loadBaseline: vi.fn(() => new Set()),
  loadGuardConfig: vi.fn(() => ({ rules: [] })),
  writeGuardConfig: vi.fn(),
  scanGuard: vi.fn(() => ({ scannedFiles: 3, suppressed: 0, findings: [] })),
  validateGuardContracts: vi.fn(() => []),
  buildGuardReviewPacket: vi.fn(() => ({ version: 1, changedFiles: [] })),
  buildGuardProposals: vi.fn(() => ({
    version: 1,
    generatedAt: 'now',
    rules: [],
    contracts: [],
    questions: [],
  })),
  buildGeneratedGuardConfig: vi.fn(() => ({ version: 1, rules: [], contracts: [] })),
  writeProjectModel: vi.fn(),
  writeGuardMemory: vi.fn(),
  writeProjectSnapshot: vi.fn(() => 'working-tree'),
  loadGuardProposals: vi.fn(),
  writeGuardProposals: vi.fn(),
  recordGuardProposalDecision: vi.fn(),
  getGuardProposalFreshness: vi.fn(() => 'current'),
}));

vi.mock('../../core/verification/verify.js', () => ({
  runGuardVerification: vi.fn(() => ({
    status: 'ok',
    checks: {},
    adapters: {},
    architecture: { findings: [] },
    contractIssues: [],
    requirement: { status: 'delegated-to-review', message: 'review' },
  })),
}));

describe('guard commands', () => {
  it('initializes the guard configuration and baseline', async () => {
    const { guardInitCommand } = await import('./guard.js');
    expect(() => guardInitCommand()).not.toThrow();
  });

  it('passes --force through when replacing Guard state', async () => {
    const { guardInitCommand } = await import('./guard.js');
    guardInitCommand({ force: true });
    const { initializeGuard } = await import('../../core/guard.js');
    expect(initializeGuard).toHaveBeenCalledWith('/project', { force: true });
  });

  it('checks the configured project without new violations', async () => {
    const { guardCheckCommand } = await import('./guard.js');
    guardCheckCommand();
    expect(process.exitCode).toBe(0);
    process.exitCode = undefined;
  });

  it('analyzes the project and refreshes the discovery snapshot', async () => {
    const { guardAnalyzeCommand } = await import('./guard.js');
    expect(() => guardAnalyzeCommand()).not.toThrow();
  });

  it('runs the unified verification gate', async () => {
    const { guardVerifyCommand } = await import('./guard.js');
    guardVerifyCommand();
    expect(process.exitCode).toBe(0);
    process.exitCode = undefined;
  });

  it('allows the CLI to skip automatically detected external adapters', async () => {
    const { guardVerifyCommand } = await import('./guard.js');
    const { runGuardVerification } = await import('../../core/verification/verify.js');

    guardVerifyCommand({ tools: 'off' });

    expect(runGuardVerification).toHaveBeenLastCalledWith(
      '/project',
      expect.objectContaining({ tools: 'off' }),
    );
    process.exitCode = undefined;
  });

  it('runs a full Guard audit', async () => {
    const { guardAuditCommand } = await import('./guard.js');
    guardAuditCommand();
    expect(process.exitCode).toBe(0);
    process.exitCode = undefined;
  });

  it('prepares a semantic review packet', async () => {
    const { guardReviewCommand } = await import('./guard.js');
    expect(() => guardReviewCommand()).not.toThrow();
    process.exitCode = undefined;
  });

  it('activates only explicitly selected proposed rules', async () => {
    const guardIndex = await import('../../core/guard.js');
    vi.mocked(guardIndex.loadGuardConfig).mockReturnValue({
      version: 1,
      rules: [
        {
          id: 'approved-rule',
          description: 'rule',
          severity: 'warning',
          kind: 'forbidden-import',
          patterns: ['internal'],
          status: 'proposed',
        },
      ],
    });
    const { guardRulesApproveCommand } = await import('./guard.js');

    guardRulesApproveCommand('approved-rule');

    expect(vi.mocked(guardIndex.writeGuardConfig)).toHaveBeenCalledWith(
      '/project',
      expect.objectContaining({ rules: [expect.objectContaining({ status: 'active' })] }),
    );
    process.exitCode = undefined;
  });
});
