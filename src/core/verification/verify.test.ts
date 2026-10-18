import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GUARD_DIR } from '../guard.js';
import { runGuardVerification } from './verify.js';

const roots: string[] = [];

function createGitPolicyRoot(): { root: string; base: string } {
  const root = mkdtempSync(join(tmpdir(), 'guard-verify-policy-git-'));
  roots.push(root);
  mkdirSync(join(root, GUARD_DIR), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: {} }));
  writeFileSync(join(root, GUARD_DIR, 'rules.json'), JSON.stringify({ version: 1, rules: [] }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'guard@example.test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Guard Test'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
  return {
    root,
    base: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim(),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('runGuardVerification', () => {
  it('reports an unconfigured Guard without running project commands', () => {
    const root = mkdtempSync(join(tmpdir(), 'guard-verify-'));
    roots.push(root);

    const result = runGuardVerification(root, { requirement: 'Implement the feature.' });

    expect(result).toMatchObject({
      status: 'not-configured',
      outcome: 'not-configured',
      checks: {},
      adapters: {},
      requirement: { status: 'delegated-to-review', provided: true },
    });
    expect(result.run).toMatchObject({
      version: 1,
      command: 'verify',
      outcome: 'not-configured',
      gate: 'configuration',
    });
  });

  it('fails closed with a structured error when policy is corrupted', () => {
    const root = mkdtempSync(join(tmpdir(), 'guard-verify-invalid-config-'));
    roots.push(root);
    mkdirSync(join(root, GUARD_DIR), { recursive: true });
    writeFileSync(join(root, GUARD_DIR, 'rules.json'), '{"version":1,"rules":[null]}');

    const result = runGuardVerification(root);

    expect(result).toMatchObject({ status: 'fail', outcome: 'fail' });
    expect(result.configError).toContain('Guard configuration is invalid');
  });

  it('fails when a configured project check has no executable result', () => {
    const root = mkdtempSync(join(tmpdir(), 'guard-verify-configured-'));
    roots.push(root);
    mkdirSync(join(root, GUARD_DIR), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: {} }));
    writeFileSync(join(root, GUARD_DIR, 'rules.json'), JSON.stringify({ version: 1, rules: [] }));

    const result = runGuardVerification(root, {
      checks: ['lint', 'test'],
      tools: 'on',
    });

    expect(result.status).toBe('fail');
    expect(result.outcome).toBe('fail');
    expect(result.run.gate).toBe('project-checks');
    expect(result.checks.lint?.status).toBe('not-configured');
    expect(result.checks.test?.status).toBe('not-configured');
    expect(result.adapters.security?.status).toBe('not-configured');
    expect(result.run.receipt).toMatchObject({
      kind: 'verification-receipt',
      subject: { changedFiles: [] },
      tool: { name: '@codapult/guard' },
    });
  });

  it('supports strict mode when a requested project check is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'guard-verify-strict-'));
    roots.push(root);
    mkdirSync(join(root, GUARD_DIR), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: {} }));
    writeFileSync(join(root, GUARD_DIR, 'rules.json'), JSON.stringify({ version: 1, rules: [] }));

    const result = runGuardVerification(root, { checks: ['test'], strict: true });

    expect(result.status).toBe('fail');
    expect(result.outcome).toBe('fail');
    expect(result.checks.test?.status).toBe('not-configured');
  });

  it('records intentional project-check skips without presenting them as executed', () => {
    const root = mkdtempSync(join(tmpdir(), 'guard-verify-skipped-'));
    roots.push(root);
    mkdirSync(join(root, GUARD_DIR), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: {} }));
    writeFileSync(join(root, GUARD_DIR, 'rules.json'), JSON.stringify({ version: 1, rules: [] }));

    const result = runGuardVerification(root, { projectChecks: false, tools: 'off' });

    expect(result.outcome).toBe('pass');
    expect(result.run.receipt).toMatchObject({
      outcome: 'pass',
      stages: { 'project-checks': 'skipped', adapters: 'skipped' },
      checks: {},
    });
  });

  it('runs all configured project checks by default', () => {
    const root = mkdtempSync(join(tmpdir(), 'guard-verify-defaults-'));
    roots.push(root);
    mkdirSync(join(root, GUARD_DIR), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: {} }));
    writeFileSync(join(root, GUARD_DIR, 'rules.json'), JSON.stringify({ version: 1, rules: [] }));

    const result = runGuardVerification(root);

    expect(Object.keys(result.checks)).toEqual(['lint', 'typecheck', 'test', 'build']);
  });

  it('runs configured external adapters by default', () => {
    const root = mkdtempSync(join(tmpdir(), 'guard-verify-adapters-'));
    roots.push(root);
    mkdirSync(join(root, GUARD_DIR), { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { security: 'node -e "process.exit(0)"' } }),
    );
    writeFileSync(join(root, GUARD_DIR, 'rules.json'), JSON.stringify({ version: 1, rules: [] }));

    const result = runGuardVerification(root, { projectChecks: false });

    expect(result.adapters.security?.status).toBe('passed');
  });

  it('separates base changes from dirty working-tree files in the receipt', () => {
    const root = mkdtempSync(join(tmpdir(), 'guard-verify-receipt-git-'));
    roots.push(root);
    mkdirSync(join(root, GUARD_DIR), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: {} }));
    writeFileSync(join(root, GUARD_DIR, 'rules.json'), JSON.stringify({ version: 1, rules: [] }));
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'guard@example.test'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Guard Test'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
    writeFileSync(join(root, 'working-tree.ts'), 'export const value = 1;\n');

    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
    const result = runGuardVerification(root, {
      policyBase: base,
      projectChecks: false,
      tools: 'off',
    });

    expect(result.run.receipt).toMatchObject({
      subject: {
        commit: base,
        baseCommit: base,
        baseChangedFiles: [],
        workingTreeFiles: ['working-tree.ts'],
        workingTreeDirty: true,
        changedFiles: ['working-tree.ts'],
      },
    });
  });

  it.each([
    [
      'changes policy contents',
      (root: string) =>
        writeFileSync(
          join(root, GUARD_DIR, 'rules.json'),
          JSON.stringify({
            version: 1,
            rules: [
              {
                id: 'new-rule',
                description: 'Reject the forbidden import.',
                severity: 'error',
                kind: 'forbidden-import',
                patterns: ['forbidden-package'],
                status: 'active',
              },
            ],
          }),
        ),
    ],
    ['deletes the policy file', (root: string) => rmSync(join(root, GUARD_DIR, 'rules.json'))],
    [
      'renames the policy file',
      (root: string) =>
        renameSync(
          join(root, GUARD_DIR, 'rules.json'),
          join(root, GUARD_DIR, 'renamed-rules.json'),
        ),
    ],
  ])('fails closed when the PR %s', (_name, mutate) => {
    const { root, base } = createGitPolicyRoot();
    mutate(root);

    const result = runGuardVerification(root, {
      policyBase: base,
      failOnPolicyChange: true,
      projectChecks: false,
      tools: 'off',
    });

    expect(result.status).toBe('fail');
    expect(result.outcome).toBe('fail');
    expect(result.run.receipt).toMatchObject({ outcome: 'fail' });
    expect(['GUARD_POLICY_CHANGED', 'GUARD_CONFIG_INVALID', 'GUARD_NOT_CONFIGURED']).toContain(
      result.errorCode,
    );
  });

  it('detects generic server/client and environment boundary regressions', () => {
    const root = mkdtempSync(join(tmpdir(), 'guard-verify-boundaries-'));
    roots.push(root);
    mkdirSync(join(root, GUARD_DIR), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: {} }));
    writeFileSync(join(root, '.env.example'), 'KNOWN=value\n');
    writeFileSync(
      join(root, 'client.tsx'),
      `'use client';\nimport { headers } from 'next/headers';\nexport const value = process.env.UNKNOWN;\n`,
    );
    writeFileSync(join(root, GUARD_DIR, 'rules.json'), JSON.stringify({ version: 1, rules: [] }));

    const result = runGuardVerification(root, { projectChecks: false });

    expect(result.impact).toBeDefined();
    expect(Array.isArray(result.impact?.requestedFiles)).toBe(true);
    expect(Array.isArray(result.impact?.affectedModules)).toBe(true);
    expect(Array.isArray(result.impact?.relevantContracts)).toBe(true);
    expect(result.architecture?.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: 'client-server-boundary', severity: 'error' }),
        expect.objectContaining({
          ruleId: 'undeclared-environment-reference',
          severity: 'warning',
        }),
      ]),
    );
    expect(result.run.receipt).toMatchObject({
      outcome: 'fail',
      gate: 'architecture',
      stages: { 'architecture-policy': 'fail' },
    });
    expect(typeof result.run.receipt?.findings.errors).toBe('number');
  });

  it('does not report pass when a project check fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'guard-verify-check-failure-'));
    roots.push(root);
    mkdirSync(join(root, GUARD_DIR), { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { test: 'node -e "process.exit(1)"' } }),
    );
    writeFileSync(join(root, GUARD_DIR, 'rules.json'), JSON.stringify({ version: 1, rules: [] }));

    const result = runGuardVerification(root, {
      checks: ['test'],
      tools: 'off',
    });

    expect(result.outcome).toBe('fail');
    expect(result.run.receipt).toMatchObject({
      outcome: 'fail',
      gate: 'project-checks',
      checks: { test: { status: 'failed' } },
      stages: { 'project-checks': 'fail' },
    });
  });

  it('fails when a relevant waiver has expired', () => {
    const root = mkdtempSync(join(tmpdir(), 'guard-verify-expired-waiver-'));
    roots.push(root);
    mkdirSync(join(root, GUARD_DIR), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: {} }));
    writeFileSync(
      join(root, GUARD_DIR, 'rules.json'),
      JSON.stringify({
        version: 1,
        rules: [
          {
            id: 'forbidden-import',
            description: 'Reject the forbidden import.',
            severity: 'warning',
            kind: 'forbidden-import',
            patterns: ['forbidden-package'],
            status: 'active',
          },
        ],
      }),
    );
    writeFileSync(join(root, 'index.ts'), "import forbidden from 'forbidden-package';\n");

    const initial = runGuardVerification(root, { projectChecks: false, tools: 'off' });
    const finding = initial.architecture?.findings[0];
    expect(finding).toBeDefined();
    writeFileSync(
      join(root, GUARD_DIR, 'waivers.json'),
      JSON.stringify({
        version: 1,
        waivers: [
          {
            id: 'expired-waiver',
            fingerprint: finding?.fingerprint,
            ruleId: finding?.ruleId,
            owner: 'platform-team',
            reason: 'Expired migration',
            createdAt: '2020-01-01T00:00:00.000Z',
            expiresAt: '2020-02-01T00:00:00.000Z',
          },
        ],
        decisions: [],
      }),
    );

    const result = runGuardVerification(root, { projectChecks: false, tools: 'off' });

    expect(result.status).toBe('fail');
    expect(result.outcome).toBe('fail');
    expect(result.run.gate).toBe('architecture');
    expect(result.run.receipt).toMatchObject({
      findings: { expiredWaivers: 1 },
      stages: { 'architecture-policy': 'fail' },
    });
  });

  it('fails when an active contract has stale paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'guard-verify-contracts-'));
    roots.push(root);
    mkdirSync(join(root, GUARD_DIR), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: {} }));
    writeFileSync(
      join(root, GUARD_DIR, 'rules.json'),
      JSON.stringify({
        version: 1,
        rules: [],
        contracts: [
          {
            id: 'stale-boundary',
            statement: 'Keep the boundary intact.',
            kind: 'import-boundary',
            scope: ['src/missing'],
            mustNotImport: ['server-only'],
          },
        ],
      }),
    );

    const result = runGuardVerification(root, { projectChecks: false });

    expect(result.status).toBe('fail');
    expect(result.outcome).toBe('fail');
    expect(result.contractIssues).toEqual([
      expect.objectContaining({ contractId: 'stale-boundary', field: 'scope' }),
    ]);
  });
});
