import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  inspectProjectRuntime,
  runProjectChecks,
  runWorkspaceProjectChecks,
} from './project-checks.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('runProjectChecks', () => {
  it('marks missing scripts as not-configured instead of failed', () => {
    const root = mkdtempSync(join(tmpdir(), 'guard-checks-'));
    roots.push(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: {} }));

    const result = runProjectChecks(root, ['lint', 'test', 'build', 'typecheck']);

    expect(result).toMatchObject({
      lint: { status: 'not-configured', passed: false },
      test: { status: 'not-configured', passed: false },
      build: { status: 'not-configured', passed: false },
      typecheck: { status: 'not-configured', passed: false },
    });
  });

  it('uses the declared typecheck script when available', () => {
    const root = mkdtempSync(join(tmpdir(), 'guard-check-script-'));
    roots.push(root);
    mkdirSync(join(root, 'src'));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        packageManager: 'npm@11',
        scripts: { typecheck: 'node -e "process.exit(0)"' },
      }),
    );

    const result = runProjectChecks(root, ['typecheck']);

    expect(result.typecheck).toMatchObject({ status: 'passed', passed: true });
  });

  it('runs test scripts exactly as declared by the project', () => {
    const root = mkdtempSync(join(tmpdir(), 'guard-test-script-'));
    roots.push(root);
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ packageManager: 'npm@11', scripts: { test: 'node -e "process.exit(0)"' } }),
    );

    const result = runProjectChecks(root, ['test']);

    expect(result.test).toMatchObject({
      status: 'passed',
      command: 'npm run test',
    });
  });

  it('reports an incompatible Node engine without running project commands', () => {
    const root = mkdtempSync(join(tmpdir(), 'guard-runtime-'));
    roots.push(root);
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ engines: { node: '>=999' }, packageManager: 'npm@11', scripts: {} }),
    );

    expect(inspectProjectRuntime(root)).toMatchObject({
      compatible: false,
      declaredNode: '>=999',
      declaredPackageManager: 'npm@11',
    });
  });

  it('accepts a matching Node engine and lockfile package manager', () => {
    const root = mkdtempSync(join(tmpdir(), 'guard-runtime-compatible-'));
    roots.push(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ engines: { node: '>=20' } }));
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');

    expect(inspectProjectRuntime(root)).toMatchObject({
      compatible: true,
      packageManager: 'pnpm',
    });
  });

  it('evaluates Node engine minor and patch constraints instead of major only', () => {
    const root = mkdtempSync(join(tmpdir(), 'guard-runtime-range-'));
    roots.push(root);
    const [major, minor, patch] = process.versions.node.split('.').map(Number);
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ engines: { node: `>=${major}.${minor}.${patch}` } }),
    );
    expect(inspectProjectRuntime(root)).toMatchObject({ compatible: true });

    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ engines: { node: `>${major}.${minor}.${patch}` } }),
    );
    expect(inspectProjectRuntime(root)).toMatchObject({ compatible: false });
  });

  it('runs a workspace check when the root does not own it', () => {
    const root = mkdtempSync(join(tmpdir(), 'guard-workspace-checks-'));
    roots.push(root);
    mkdirSync(join(root, 'packages', 'web'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: {} }));
    writeFileSync(
      join(root, 'packages', 'web', 'package.json'),
      JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
    );

    const rootResults = runProjectChecks(root, ['test']);
    const workspaceResults = runWorkspaceProjectChecks(
      root,
      [{ path: 'packages/web', scripts: { test: 'node -e "process.exit(0)"' } }],
      ['test'],
      { rootResults },
    );

    expect(workspaceResults['packages/web'].test).toMatchObject({
      status: 'passed',
      command: 'pnpm run test',
    });
  });
});
