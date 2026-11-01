import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GUARD_DIR } from '../guard.js';
import { runGuardVerification } from './verify.js';

const roots: string[] = [];

function createGitPolicyRoot(
  files: Record<string, string> = {},
  rules: unknown = { version: 1, rules: [] },
): { root: string; base: string } {
  const root = mkdtempSync(join(tmpdir(), 'guard-verify-policy-git-'));
  roots.push(root);
  mkdirSync(join(root, GUARD_DIR), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: {} }));
  writeFileSync(join(root, GUARD_DIR, 'rules.json'), JSON.stringify(rules));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
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

  it('records SHAs from the pull request attached to a trusted workflow_run event', () => {
    const root = mkdtempSync(join(tmpdir(), 'guard-verify-workflow-run-'));
    roots.push(root);
    mkdirSync(join(root, GUARD_DIR), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: {} }));
    writeFileSync(join(root, GUARD_DIR, 'rules.json'), JSON.stringify({ version: 1, rules: [] }));
    const eventPath = join(root, 'event.json');
    const headSha = 'a'.repeat(40);
    const baseSha = 'b'.repeat(40);
    writeFileSync(
      eventPath,
      JSON.stringify({
        workflow_run: {
          pull_requests: [{ head: { sha: headSha }, base: { sha: baseSha } }],
        },
      }),
    );
    const previous = {
      eventName: process.env.GITHUB_EVENT_NAME,
      eventPath: process.env.GITHUB_EVENT_PATH,
      sha: process.env.GITHUB_SHA,
    };

    try {
      process.env.GITHUB_EVENT_NAME = 'workflow_run';
      process.env.GITHUB_EVENT_PATH = eventPath;
      process.env.GITHUB_SHA = 'c'.repeat(40);
      const result = runGuardVerification(root, { projectChecks: false, tools: 'off' });

      expect(result.run.receipt?.subject).toMatchObject({
        githubEvent: 'workflow_run',
        headSha,
        baseSha,
      });
      expect(result.run.receipt?.subject.mergeSha).toBeUndefined();
    } finally {
      if (previous.eventName === undefined) delete process.env.GITHUB_EVENT_NAME;
      else process.env.GITHUB_EVENT_NAME = previous.eventName;
      if (previous.eventPath === undefined) delete process.env.GITHUB_EVENT_PATH;
      else process.env.GITHUB_EVENT_PATH = previous.eventPath;
      if (previous.sha === undefined) delete process.env.GITHUB_SHA;
      else process.env.GITHUB_SHA = previous.sha;
    }
  });

  it('returns incomplete when a policy-required project-check stage was skipped', () => {
    const { root } = createGitPolicyRoot(
      {},
      {
        version: 1,
        rules: [],
        completionGate: { requiredStages: ['project-checks'] },
      },
    );
    writeFileSync(
      join(root, GUARD_DIR, 'agent.json'),
      JSON.stringify({
        version: 1,
        tools: 'auto',
        tooling: {},
        completionGate: {
          enabled: true,
          maxIterations: 3,
          projectChecks: true,
          checks: ['lint', 'typecheck', 'test', 'build'],
          requiredStages: ['project-checks'],
        },
      }),
    );

    const result = runGuardVerification(root, { projectChecks: false, tools: 'off' });

    expect(result.outcome).toBe('incomplete');
    expect(result.status).toBe('incomplete');
    expect(result.requiredStages).toContain('project-checks');
    expect(result.incompleteStages).toContain('project-checks');
    expect(result.run.receipt?.stages['project-checks']).toBe('skipped');
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
      verificationScope: {
        algorithm: 'sha256',
        complete: true,
        stable: true,
      },
    });
    expect(result.requiredStages).toContain('verification-scope');
    const scopeFile = result.run.receipt?.verificationScope?.files.find(
      (file) => file.path === 'working-tree.ts',
    );
    expect(scopeFile).toEqual({
      path: 'working-tree.ts',
      status: 'present',
      sha256: createHash('sha256').update('export const value = 1;\n').digest('hex'),
    });
    expect(result.run.receipt?.verificationScope?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.run.receipt?.tool.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('binds a deleted tracked file to its last committed bytes', () => {
    const content = 'export const retired = true;\n';
    const { root, base } = createGitPolicyRoot({ 'deleted.ts': content });
    rmSync(join(root, 'deleted.ts'));

    const result = runGuardVerification(root, {
      policyBase: base,
      projectChecks: false,
      tools: 'off',
    });

    expect(result.run.receipt?.verificationScope?.files).toContainEqual({
      path: 'deleted.ts',
      status: 'deleted',
      sha256: createHash('sha256').update(content).digest('hex'),
    });
    expect(result.run.receipt?.verificationScope).toMatchObject({ complete: true, stable: true });
  });

  it('marks the verification incomplete if a check changes a scoped file', () => {
    const { root } = createGitPolicyRoot({ 'subject.ts': 'export const value = 1;\n' });
    const script =
      "node -e \"require('node:fs').writeFileSync('subject.ts', 'export const value = 2;\\\\n')\"";
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: script } }));

    const result = runGuardVerification(root, { checks: ['test'], tools: 'off' });

    expect(result.outcome).toBe('incomplete');
    expect(result.run.receipt?.outcome).toBe('incomplete');
    expect(result.run.receipt?.verificationScope).toMatchObject({ complete: true, stable: false });
    expect(result.run.receipt?.incompleteStages).toContain('verification-scope');
    expect(result.run.receipt?.checks.test).toMatchObject({
      status: 'passed',
      execution: 'attempted',
    });
  });

  it('reports added suppressions and protected-path changes from the trusted base', () => {
    const { root, base } = createGitPolicyRoot(
      {
        'new-source.ts': 'export const value = 1;\n',
        '.gitignore': 'build/\n',
        'agent.config': 'strict=true\n',
      },
      {
        version: 1,
        rules: [],
        policySurface: {
          paths: [{ pattern: 'agent.config', kind: 'custom', severity: 'error' }],
        },
      },
    );
    writeFileSync(
      join(root, 'new-source.ts'),
      '// eslint-disable-next-line\nexport const value = 1;\n',
    );
    writeFileSync(join(root, '.gitignore'), 'build/\ncoverage/\n');
    writeFileSync(join(root, '.ignore'), 'generated/\n');
    writeFileSync(join(root, 'agent.config'), 'strict=false\n');
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { test: 'echo changed' } }),
    );
    writeFileSync(join(root, GUARD_DIR, 'rules.json'), JSON.stringify({ version: 1, rules: [] }));

    const result = runGuardVerification(root, {
      policyBase: base,
      failOnProtectedChanges: true,
      projectChecks: false,
      tools: 'off',
    });

    expect(result.errorCode).toBe('GUARD_PROTECTED_PATH_CHANGED');
    expect(result.policySurface).toMatchObject({
      complete: true,
      suppressionMarkers: ['new-source.ts:eslint-disable'],
    });
    expect(result.policySurface?.changedPaths).toContain('package.json');
    expect(result.policySurface?.changedPaths).toContain('.ignore');
    expect(result.policySurface?.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '.gitignore', kind: 'ignore-config', severity: 'error' }),
        expect.objectContaining({ path: '.ignore', kind: 'ignore-config', severity: 'error' }),
        expect.objectContaining({ path: 'agent.config', kind: 'custom', severity: 'error' }),
      ]),
    );
    expect(result.run.receipt).toMatchObject({
      policySurface: { complete: true, suppressionMarkers: ['new-source.ts:eslint-disable'] },
    });
  });

  it('checks proposed code against base policy without granting approval to policy changes', () => {
    const baseRule = {
      id: 'forbidden-import',
      description: 'Reject the forbidden import.',
      severity: 'error',
      kind: 'forbidden-import',
      patterns: ['forbidden-package'],
      status: 'active',
    };
    const { root, base } = createGitPolicyRoot(
      { 'src/subject.ts': 'export const value = 1;\n' },
      { version: 1, rules: [baseRule] },
    );
    writeFileSync(join(root, GUARD_DIR, 'rules.json'), JSON.stringify({ version: 1, rules: [] }));

    const result = runGuardVerification(root, {
      policyBase: base,
      projectChecks: false,
      tools: 'off',
    });

    expect(result.outcome).toBe('pass');
    expect(result.status).toBe('ok');
    expect(result.policyChanged).toBe(true);
    expect(result.policy?.source).toBe('git-ref');
    expect(result.policySurface?.changedPaths).toContain(`${GUARD_DIR}/rules.json`);
    expect(result.architecture?.findings).toEqual([]);
  });

  it('uses the base rule when the PR weakens that rule and violates it in the same change', () => {
    const baseRule = {
      id: 'forbidden-import',
      description: 'Reject the forbidden import.',
      severity: 'error',
      kind: 'forbidden-import',
      patterns: ['forbidden-package'],
      status: 'active',
    };
    const { root, base } = createGitPolicyRoot(
      { 'src/subject.ts': 'export const value = 1;\n' },
      { version: 1, rules: [baseRule] },
    );
    writeFileSync(join(root, GUARD_DIR, 'rules.json'), JSON.stringify({ version: 1, rules: [] }));
    writeFileSync(join(root, 'src/subject.ts'), "import value from 'forbidden-package';\n");

    const result = runGuardVerification(root, {
      policyBase: base,
      projectChecks: false,
      tools: 'off',
    });

    expect(result.architecture?.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ ruleId: 'forbidden-import' })]),
    );
    expect(result.run.receipt?.policy).toMatchObject({ source: 'git-ref', ref: base });
    expect(result.run.receipt?.subject.workingTreeFiles).toEqual(
      expect.arrayContaining([`${GUARD_DIR}/rules.json`, 'src/subject.ts']),
    );
  });

  it('reports deletion of a protected file as a policy-surface change', () => {
    const { root, base } = createGitPolicyRoot(
      { 'agent.config': 'strict=true\n' },
      {
        version: 1,
        rules: [],
        policySurface: {
          paths: [{ pattern: 'agent.config', kind: 'custom', severity: 'error' }],
        },
      },
    );
    rmSync(join(root, 'agent.config'));

    const result = runGuardVerification(root, {
      policyBase: base,
      failOnProtectedChanges: true,
      projectChecks: false,
      tools: 'off',
    });

    expect(result.errorCode).toBe('GUARD_PROTECTED_PATH_CHANGED');
    expect(result.policySurface?.changes).toContainEqual(
      expect.objectContaining({ path: 'agent.config', kind: 'custom', severity: 'error' }),
    );
  });

  it('uses the base policy to audit and report a weakened CI workflow', () => {
    const workflowPath = '.github/workflows/guard.yml';
    const workflow = [
      'name: Guard',
      'on: pull_request',
      'permissions:',
      '  contents: read',
      'jobs:',
      '  guard:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: pnpm exec codapult-guard verify --policy-base "$BASE_SHA"',
      '',
    ].join('\n');
    const rules = {
      version: 1,
      rules: [],
      githubActions: {
        workflows: [
          {
            path: workflowPath,
            job: 'guard',
            requiredRunIncludes: ['pnpm exec codapult-guard verify', '--policy-base'],
          },
        ],
      },
    };
    const { root, base } = createGitPolicyRoot({ [workflowPath]: workflow }, rules);
    writeFileSync(join(root, workflowPath), workflow.replace(' --policy-base "$BASE_SHA"', ''));

    const result = runGuardVerification(root, {
      policyBase: base,
      projectChecks: false,
      tools: 'off',
    });

    expect(result.status).toBe('policy-weakened');
    expect(result.ciIntegrity?.status).toBe('policy-weakened');
    expect(result.ciIntegrity?.workflows[0]?.path).toBe(workflowPath);
    expect(result.ciIntegrity?.workflows[0]?.status).toBe('policy-weakened');
    expect(result.ciIntegrity?.workflows[0]?.issues.map((issue) => issue.code)).toContain(
      'command-missing',
    );
    expect(result.run.receipt?.ciIntegrity).toEqual(result.ciIntegrity);
    expect(result.run.receipt?.policy?.source).toBe('git-ref');
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
    const receipt = result.run.receipt;
    expect(receipt?.outcome).toBe('fail');
    expect(receipt?.gate).toBe('project-checks');
    expect(receipt?.checks.test).toMatchObject({ status: 'failed', execution: 'attempted' });
    expect(receipt?.checks.test.command).toContain('test');
    expect(Array.isArray(receipt?.checks.test.args)).toBe(true);
    expect(receipt?.tool).toMatchObject({ name: '@codapult/guard' });
    expect(receipt?.tool.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(receipt?.stages['project-checks']).toBe('fail');
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
