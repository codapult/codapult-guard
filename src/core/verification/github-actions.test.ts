import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GuardGitHubActionsPolicy } from '../guard.js';
import { auditGitHubActions } from './github-actions.js';

const roots: string[] = [];
const workflowPath = '.github/workflows/guard.yml';
const actionShaA = 'a'.repeat(40);
const actionShaB = 'b'.repeat(40);

function createRoot(workflow: string): { root: string; base: string } {
  const root = mkdtempSync(join(tmpdir(), 'guard-ci-integrity-'));
  roots.push(root);
  mkdirSync(dirname(join(root, workflowPath)), { recursive: true });
  writeFileSync(join(root, workflowPath), workflow);
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

function policy(): GuardGitHubActionsPolicy {
  return {
    workflows: [
      {
        path: workflowPath,
        job: 'guard',
        requiredRunIncludes: ['pnpm exec codapult-guard verify', '--policy-base'],
      },
    ],
  };
}

function workflowWithAction(action: string): string {
  return [
    'name: Guard',
    'on: pull_request',
    'permissions:',
    '  contents: read',
    'jobs:',
    '  guard:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    `      - uses: ${action}`,
    '      - run: pnpm exec codapult-guard verify --policy-base "$BASE_SHA"',
    '',
  ].join('\n');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('GitHub Actions integrity audit', () => {
  it('accepts the contracted workflow and binds its digest to the base revision', () => {
    const { root, base } = createRoot(workflowWithAction(`actions/checkout@${actionShaA}`));

    const result = auditGitHubActions(root, policy(), base);

    const workflow = result?.workflows[0];
    expect(result?.status).toBe('ok');
    expect(workflow?.path).toBe(workflowPath);
    expect(workflow?.job).toBe('guard');
    expect(workflow?.status).toBe('ok');
    expect(workflow?.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(workflow?.baseDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(workflow?.actions).toEqual([`actions/checkout@${actionShaA}`]);
    expect(workflow?.baseActions).toEqual([`actions/checkout@${actionShaA}`]);
    expect(workflow?.actionChanges).toEqual([]);
  });

  it('reports changed action refs as a policy weakening even when both refs are pinned', () => {
    const { root, base } = createRoot(workflowWithAction(`actions/checkout@${actionShaA}`));
    writeFileSync(join(root, workflowPath), workflowWithAction(`actions/checkout@${actionShaB}`));

    const result = auditGitHubActions(root, policy(), base);

    const workflow = result?.workflows[0];
    expect(result?.status).toBe('policy-weakened');
    expect(workflow?.status).toBe('policy-weakened');
    expect(workflow?.actions).toEqual([`actions/checkout@${actionShaB}`]);
    expect(workflow?.baseActions).toEqual([`actions/checkout@${actionShaA}`]);
    expect(workflow?.actionChanges).toEqual([
      {
        name: 'actions/checkout',
        base: [`actions/checkout@${actionShaA}`],
        current: [`actions/checkout@${actionShaB}`],
      },
    ]);
    expect(workflow?.issues.map((issue) => issue.code)).toContain('action-reference-changed');
  });

  it.each([
    {
      name: 'a removed Guard job',
      workflow: (base: string) => base.replace('  guard:\n', '  other:\n'),
      code: 'job-missing',
    },
    {
      name: 'a conditional Guard job',
      workflow: (base: string) =>
        base.replace('    runs-on:', '    if: github.event_name == "push"\n    runs-on:'),
      code: 'job-conditional',
    },
    {
      name: 'a filtered pull request trigger',
      workflow: (base: string) =>
        base.replace('on: pull_request', 'on:\n  pull_request:\n    paths: ["src/**"]'),
      code: 'pull-request-filtered',
    },
    {
      name: 'continue-on-error on the Guard job',
      workflow: (base: string) =>
        base.replace('    runs-on:', '    continue-on-error: true\n    runs-on:'),
      code: 'continue-on-error',
    },
    {
      name: 'a conditional verifier step',
      workflow: (base: string) =>
        base.replace('      - run:', '      - if: github.event_name == "push"\n        run:'),
      code: 'step-conditional',
    },
    {
      name: 'continue-on-error on the verifier step',
      workflow: (base: string) =>
        base.replace('      - run:', '      - continue-on-error: true\n        run:'),
      code: 'continue-on-error',
    },
  ])('rejects $name', ({ workflow: mutate, code }) => {
    const baseline = workflowWithAction(`actions/checkout@${actionShaA}`);
    const { root, base } = createRoot(baseline);
    writeFileSync(join(root, workflowPath), mutate(baseline));

    const result = auditGitHubActions(root, policy(), base);

    expect(result?.status).toBe('policy-weakened');
    expect(result?.workflows[0]?.issues.map((issue) => issue.code)).toContain(code);
  });

  it('marks malformed workflow content incomplete instead of accepting it', () => {
    const { root } = createRoot('jobs: [invalid\n');

    const result = auditGitHubActions(root, policy());

    expect(result?.status).toBe('incomplete');
    expect(result?.workflows[0]?.status).toBe('incomplete');
    expect(result?.workflows[0]?.issues.map((issue) => issue.code)).toContain('workflow-invalid');
  });

  it('marks the audit incomplete when the contracted workflow is unavailable from the base', () => {
    const { root } = createRoot(workflowWithAction(`actions/checkout@${actionShaA}`));

    const result = auditGitHubActions(root, policy(), 'f'.repeat(40));

    expect(result?.status).toBe('incomplete');
    expect(result?.workflows[0]?.status).toBe('incomplete');
    expect(result?.workflows[0]?.issues.map((issue) => issue.code)).toContain(
      'base-workflow-unavailable',
    );
  });

  it('returns no audit when no trusted CI contract is configured', () => {
    const { root } = createRoot(workflowWithAction(`actions/checkout@${actionShaA}`));

    expect(auditGitHubActions(root, undefined)).toBeUndefined();
  });
});
