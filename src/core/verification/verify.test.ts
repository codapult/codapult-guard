import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GUARD_DIR } from '../guard.js';
import { runGuardVerification } from './verify.js';

const roots: string[] = [];

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
  });

  it('does not fail a configured project when checks are not configured', () => {
    const root = mkdtempSync(join(tmpdir(), 'guard-verify-configured-'));
    roots.push(root);
    mkdirSync(join(root, GUARD_DIR), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: {} }));
    writeFileSync(join(root, GUARD_DIR, 'rules.json'), JSON.stringify({ version: 1, rules: [] }));

    const result = runGuardVerification(root, {
      checks: ['lint', 'test'],
      tools: 'on',
    });

    expect(result.status).toBe('ok');
    expect(result.checks.lint?.status).toBe('not-configured');
    expect(result.checks.test?.status).toBe('not-configured');
    expect(result.adapters.security?.status).toBe('not-configured');
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

    expect(result.architecture?.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: 'client-server-boundary', severity: 'error' }),
        expect.objectContaining({
          ruleId: 'undeclared-environment-reference',
          severity: 'warning',
        }),
      ]),
    );
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
