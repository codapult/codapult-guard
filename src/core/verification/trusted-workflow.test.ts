import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

interface TrustedWorkflow {
  on?: { workflow_run?: { workflows?: string[]; types?: string[] } };
  jobs?: Record<
    string,
    {
      needs?: string | string[];
      permissions?: Record<string, string>;
      steps?: { uses?: string; run?: string; with?: Record<string, string> }[];
    }
  >;
}

const workflow = parse(
  readFileSync(new URL('../../../docs/guard-trusted-pr-attestation.yml', import.meta.url), 'utf8'),
) as TrustedWorkflow;

describe('trusted PR attestation workflow template', () => {
  it('runs from workflow_run after the ordinary Guard PR workflow', () => {
    expect(workflow.on?.workflow_run).toEqual({ workflows: ['Guard'], types: ['completed'] });
  });

  it('keeps OIDC signing separate from the verifier that reads PR files', () => {
    expect(workflow.jobs?.verify.permissions).toEqual({ contents: 'read' });
    expect(workflow.jobs?.attest.needs).toBe('verify');
    expect(workflow.jobs?.attest.permissions).toMatchObject({
      'id-token': 'write',
      attestations: 'write',
      'artifact-metadata': 'write',
    });
  });

  it('checks out the PR head, uses base policy, and never runs project checks', () => {
    const steps = workflow.jobs?.verify.steps ?? [];
    const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    const install = steps.find((step) => step.run?.includes('npm install'));
    const verify = steps.find((step) => step.run?.includes('codapult-guard verify'));

    expect(checkout?.with?.ref).toContain('refs/pull/');
    expect(install?.run).toContain('--ignore-scripts');
    expect(verify?.run).toContain('--no-project-checks');
    expect(verify?.run).toContain('--policy-base "$BASE_SHA"');
    expect(verify?.run).toContain('--fail-on-policy-change');
    expect(verify?.run).toContain('--fail-on-protected-changes');
  });

  it('pins all external actions to full commit SHAs', () => {
    for (const job of Object.values(workflow.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (step.uses) expect(step.uses).toMatch(/@[a-f0-9]{40}\b/i);
      }
    }
  });
});
