import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GUARD_DIR,
  GUARD_HISTORY_DIR,
  GUARD_PROJECT_FILE,
  GUARD_AGENT_FILE,
  GUARD_BASELINE_META_FILE,
  GUARD_CONTRACTS_FILE,
  buildGeneratedGuardConfig,
  buildArchitectureMemory,
  buildConventionsMemory,
  discoverProject,
  loadGuardConfig,
  loadGuardAgentConfig,
  loadGuardArtifact,
  loadBaseline,
  updateBaseline,
  scanGuard,
  type GuardConfig,
  writeProjectSnapshot,
  redactSensitiveText,
  writeBaseline,
  writeGuardConfig,
  writeProjectModel,
  validateGuardContracts,
  initializeGuard,
  GuardAlreadyInitializedError,
  writeGuardAgentConfig,
  defaultGuardAgentConfig,
  loadGuardProposals,
  recordGuardProposalDecision,
  writeGuardProposals,
  fingerprintProjectModel,
  getGuardProposalFreshness,
  buildGuardReviewPacket,
  classifyGuardOutcome,
} from './guard.js';

const config: GuardConfig = {
  version: 1,
  rules: [
    {
      id: 'client-no-db',
      description: 'Client components must not import the database.',
      severity: 'error',
      kind: 'client-forbidden-import',
      patterns: ['@/lib/db'],
    },
  ],
};

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'codapult-guard-'));
  roots.push(root);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content, 'utf8');
  }
  return root;
}

describe('scanGuard', () => {
  it('reports forbidden server imports from client components', () => {
    const root = createProject({
      'client.tsx': `'use client';\nimport { db } from '@/lib/db';\n`,
      'server.ts': `import { db } from '@/lib/db';\n`,
    });

    const report = scanGuard(root, config);

    expect(report.scannedFiles).toBe(2);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      file: 'client.tsx',
      line: 2,
      importPath: '@/lib/db',
      ruleId: 'client-no-db',
    });
  });

  it('reports forbidden side-effect imports', () => {
    const root = createProject({
      'entry.ts': `import './server-only';\n`,
      'server-only.ts': `export const serverOnly = true;\n`,
    });

    const report = scanGuard(root, {
      version: 1,
      rules: [
        {
          id: 'no-server-side-effect',
          description: 'This import is forbidden.',
          severity: 'error',
          kind: 'forbidden-import',
          patterns: ['./server-only'],
        },
      ],
    });

    expect(report.findings).toContainEqual(
      expect.objectContaining({ file: 'entry.ts', importPath: './server-only' }),
    );
  });

  it('suppresses findings present in the baseline', () => {
    const root = createProject({
      'client.tsx': `'use client';\nimport { db } from '@/lib/db';\n`,
      'icon.tsx': `import { DrizzleIcon } from './svg/DrizzleIcon';\n`,
    });
    const initial = scanGuard(root, config);

    const report = scanGuard(root, config, {
      baseline: new Set(initial.findings.map((finding) => finding.fingerprint)),
    });

    expect(report.findings).toEqual([]);
    expect(report.suppressed).toBe(1);
  });

  it('records baseline metadata for later audit', () => {
    const root = createProject({});
    writeBaseline(root, []);

    expect(JSON.parse(readFileSync(join(root, GUARD_BASELINE_META_FILE), 'utf8'))).toMatchObject({
      version: 1,
      findings: 0,
    });
  });

  it('updates individual baseline fingerprints and records the reason', () => {
    const root = createProject({});
    writeBaseline(root, [
      {
        ruleId: 'legacy',
        severity: 'warning',
        file: 'old.ts',
        line: 1,
        importPath: 'legacy',
        message: 'Legacy finding',
        fingerprint: 'legacy-fingerprint',
      },
    ]);

    updateBaseline(root, { add: ['new-fingerprint'], reason: 'Reviewed legacy debt' });

    expect(loadBaseline(root)).toEqual(new Set(['legacy-fingerprint', 'new-fingerprint']));
    expect(readFileSync(join(root, GUARD_BASELINE_META_FILE), 'utf8')).toContain(
      'Reviewed legacy debt',
    );
  });

  it('adds generated-state ignores only when the project uses the formatter', () => {
    const root = createProject({
      'package.json': JSON.stringify({ devDependencies: { prettier: '^1' } }),
      '.prettierignore': 'coverage/\n',
    });

    initializeGuard(root);

    expect(readFileSync(join(root, '.prettierignore'), 'utf8')).toContain(`${GUARD_DIR}/`);
  });

  it('reports architecture cycles when insight scanning is enabled', () => {
    const root = createProject({
      'a.ts': `import { b } from './b'; export const a = b;\n`,
      'b.ts': `import { a } from './a'; export const b = a;\n`,
    });

    const report = scanGuard(root, config, { includeArchitectureInsights: true });

    const cycleFinding = report.findings.find((finding) => finding.ruleId === 'architecture-cycle');
    expect(cycleFinding?.severity).toBe('warning');
    expect(cycleFinding?.message).toContain('Circular dependency detected');
  });
});

describe('guard contracts', () => {
  it('loads the default completion-gate policy and validates custom settings', () => {
    const root = createProject({});

    expect(loadGuardAgentConfig(root)).toEqual(defaultGuardAgentConfig);
    writeGuardAgentConfig(root, {
      ...defaultGuardAgentConfig,
      completionGate: { ...defaultGuardAgentConfig.completionGate, maxIterations: 5 },
    });

    expect(loadGuardAgentConfig(root).completionGate.maxIterations).toBe(5);
    expect(existsSync(join(root, GUARD_AGENT_FILE))).toBe(true);
  });

  it('protects an existing baseline from accidental reinitialization', () => {
    const root = createProject({
      'package.json': JSON.stringify({ name: 'fixture', scripts: {} }),
    });
    mkdirSync(join(root, GUARD_DIR), { recursive: true });
    writeFileSync(join(root, GUARD_DIR, 'baseline.json'), '[]');

    expect(() => initializeGuard(root)).toThrow(GuardAlreadyInitializedError);
    expect(() => initializeGuard(root, { force: true })).not.toThrow();
  });

  it('loads project contracts without treating them as executable findings', () => {
    const root = mkdtempSync(join(tmpdir(), 'codapult-contracts-'));
    roots.push(root);
    mkdirSync(join(root, GUARD_DIR), { recursive: true });
    writeFileSync(
      join(root, GUARD_DIR, 'rules.json'),
      JSON.stringify({
        version: 1,
        rules: [],
        contracts: [
          {
            id: 'auth-entrypoint',
            statement: 'Use the approved auth service for identity checks.',
            scope: ['src/app', 'src/actions'],
            guidance: ['Call requireUser()', 'Do not query the session table directly'],
            references: ['src/lib/auth/service.ts'],
          },
        ],
      }),
    );

    expect(loadGuardConfig(root)?.contracts?.[0]).toMatchObject({ id: 'auth-entrypoint' });
  });

  it('enforces opt-in import-boundary contracts deterministically', () => {
    const root = createProject({
      'src/action.ts': `import { db } from './db'; export const action = () => db;`,
      'src/db.ts': `export const db = {};`,
    });
    const report = scanGuard(root, {
      version: 1,
      rules: [],
      contracts: [
        {
          id: 'actions-no-db',
          statement: 'Actions must use the repository boundary.',
          kind: 'import-boundary',
          scope: ['src'],
          mustNotImport: ['./db'],
          status: 'active',
        },
      ],
    });

    expect(report.findings).toContainEqual(
      expect.objectContaining({
        ruleId: 'contract:actions-no-db',
        file: 'src/action.ts',
        importPath: './db',
      }),
    );
  });

  it('limits contracts to entrypoints and excludes generated or helper files', () => {
    const root = createProject({
      'src/action.ts': `import { db } from './db'; export const action = () => db;`,
      'src/helper.ts': `import { db } from './db'; export const helper = () => db;`,
      'src/db.ts': `export const db = {};`,
    });
    const report = scanGuard(root, {
      version: 1,
      rules: [],
      contracts: [
        {
          id: 'entrypoint-boundary',
          statement: 'Only the action entrypoint is checked.',
          kind: 'import-boundary',
          entrypoints: ['src/action.ts'],
          exclude: ['src/helper.ts'],
          mustNotImport: ['./db'],
          status: 'active',
        },
      ],
    });

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].file).toBe('src/action.ts');
  });

  it('keeps proposal decisions as an append-only review history', () => {
    const root = createProject({});
    writeGuardProposals(root, {
      version: 1,
      generatedAt: 'now',
      proposalId: 'proposal-id',
      contentFingerprint: 'content-hash',
      revision: 2,
      rules: [],
      contracts: [{ id: 'contract', statement: 'Use the service.' }],
      questions: [],
    });

    recordGuardProposalDecision(root, [{ id: 'contract', type: 'contract', decision: 'rejected' }]);

    expect(loadGuardProposals(root)?.decisions).toMatchObject([
      {
        id: 'contract',
        type: 'contract',
        decision: 'rejected',
        proposalId: 'proposal-id',
        proposalFingerprint: 'content-hash',
        revision: 2,
      },
    ]);
  });

  it('reports incomplete deterministic contract definitions', () => {
    const root = createProject({});

    expect(
      validateGuardContracts(root, [
        { id: 'boundary', statement: 'Boundary', kind: 'import-boundary' },
        { id: 'call', statement: 'Call', kind: 'required-call' },
      ]),
    ).toEqual([
      expect.objectContaining({ contractId: 'boundary', field: 'definition' }),
      expect.objectContaining({ contractId: 'call', field: 'definition' }),
    ]);
  });

  it('detects stale proposals after the project model changes', () => {
    const root = createProject({ 'src/value.ts': 'export const value = 1;\n' });
    const model = discoverProject(root);
    const proposal = {
      version: 1 as const,
      generatedAt: 'now',
      projectFingerprint: fingerprintProjectModel(model),
      rules: [],
      contracts: [],
      questions: [],
    };

    expect(getGuardProposalFreshness(model, proposal)).toBe('current');
    writeFileSync(join(root, 'src/added.ts'), 'export const added = true;\n');
    expect(getGuardProposalFreshness(discoverProject(root), proposal)).toBe('stale');
  });

  it('writes a commit-keyed local project snapshot', () => {
    const root = mkdtempSync(join(tmpdir(), 'codapult-snapshot-'));
    roots.push(root);
    const revision = writeProjectSnapshot(root, discoverProject(root));

    expect(revision).toBe('working-tree');
    expect(existsSync(join(root, GUARD_HISTORY_DIR, `${revision}.json`))).toBe(true);
  });

  it('rejects malformed config and preserves only valid baseline fingerprints', () => {
    const root = createProject({});
    mkdirSync(join(root, GUARD_DIR), { recursive: true });
    writeFileSync(join(root, GUARD_DIR, 'rules.json'), '{"version":1,"rules":[null]}');
    writeFileSync(join(root, GUARD_DIR, 'baseline.json'), JSON.stringify(['ok', 42, null]));

    expect(loadGuardConfig(root)).toBeUndefined();
    expect(loadBaseline(root)).toEqual(new Set(['ok']));
  });

  it('writes and reads Guard artifacts and reports missing contract paths', () => {
    const root = createProject({ 'src/existing.ts': 'export const value = 1;' });
    const model = discoverProject(root);
    const guardConfig: GuardConfig = { version: 1, rules: [] };

    writeGuardConfig(root, guardConfig);
    writeProjectModel(root, model);
    writeBaseline(root, [
      {
        ruleId: 'rule',
        severity: 'warning',
        file: 'src/existing.ts',
        line: 1,
        importPath: 'x',
        message: 'message',
        fingerprint: 'fingerprint',
      },
    ]);

    expect(loadGuardConfig(root)).toEqual({ ...guardConfig, contracts: [] });
    expect(JSON.parse(readFileSync(join(root, GUARD_CONTRACTS_FILE), 'utf8'))).toEqual({
      version: 1,
      contracts: [],
    });
    expect(loadGuardArtifact(root, GUARD_PROJECT_FILE)).toMatchObject({ version: 1 });
    expect(loadBaseline(root)).toEqual(new Set(['fingerprint']));
    expect(
      validateGuardContracts(root, [
        { id: 'contract', statement: 'statement', scope: ['missing'], references: ['other'] },
      ]),
    ).toHaveLength(2);
  });
});

describe('generated project memory', () => {
  it('classifies outcomes consistently for hosts and CI', () => {
    expect(classifyGuardOutcome({})).toBe('pass');
    expect(classifyGuardOutcome({ warnings: 1 })).toBe('warning');
    expect(classifyGuardOutcome({ needsReview: true })).toBe('needs-review');
    expect(classifyGuardOutcome({ errors: 1, needsReview: true })).toBe('fail');
    expect(classifyGuardOutcome({ configured: false })).toBe('not-configured');
  });

  it('records observed architecture and proposes evidence-backed rules', () => {
    const root = createProject({
      'package.json': JSON.stringify({
        name: 'fixture',
        dependencies: { '@prisma/client': '^1.0.0', next: '^1.0.0' },
        scripts: { test: 'vitest' },
      }),
      'client.tsx': `'use client';\nimport { db } from '@/lib/db';\n`,
      'lib/db.ts': `export const db = {};\n`,
      'app/page.tsx': `export default function Page() { return null; }\n`,
    });
    const model = discoverProject(root);
    const architecture = buildArchitectureMemory(model);
    const conventions = buildConventionsMemory(model);
    const generated = buildGeneratedGuardConfig(model);

    expect(architecture).toMatchObject({
      persistence: { packages: ['@prisma/client'] },
    });
    expect(conventions).toMatchObject({ packageManager: undefined });
    expect(generated.rules[0]).toMatchObject({
      id: 'client-no-persistence-import',
      status: 'proposed',
      confidence: 'medium',
      evidence: ['client.tsx'],
    });
    expect(generated.rules[0].patterns).not.toContain('./svg/DrizzleIcon');
  });

  it('redacts credential-shaped values from review text', () => {
    const result = redactSensitiveText(
      'apiKey=sk_live_123456 secret: super-secret-value\n-----BEGIN PRIVATE KEY-----abc-----END PRIVATE KEY-----',
    );

    expect(result.redacted).toBe(true);
    expect(result.value).not.toContain('sk_live_123456');
    expect(result.value).not.toContain('super-secret-value');
    expect(result.value).not.toContain('BEGIN PRIVATE KEY');
  });

  it('reports an invalid Git review base instead of returning a successful empty packet', () => {
    const root = createProject({
      'package.json': JSON.stringify({ name: 'review-fixture' }),
      'src/index.ts': 'export const value = 1;\n',
    });

    const packet = buildGuardReviewPacket(
      root,
      { version: 1, rules: [], contracts: [] },
      new Set(),
      10_000,
      true,
      undefined,
      'missing-base-ref',
    );

    expect(packet.diffError).toContain('missing-base-ref');
    expect(packet.diff).toBe('');
    expect(packet.outcome).toBe('fail');
  });
});
