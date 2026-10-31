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
      steps?: { uses?: string; run?: string; with?: Record<string, string | boolean> }[];
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

  it('uses Checkout v7 fork protection and never executes PR project code', () => {
    const steps = workflow.jobs?.verify.steps ?? [];
    const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    const source = steps.find((step) => step.run?.includes('GUARD_COMMIT'));
    const install = steps.find((step) => step.run?.includes('pnpm install --frozen-lockfile'));
    const verify = steps.find((step) => step.run?.includes('dist/cli/index.js" verify'));

    expect(checkout?.with?.ref).toContain('refs/pull/');
    expect(checkout?.with?.['allow-unsafe-pr-checkout']).toBeUndefined();
    expect(install?.run).toContain('--ignore-scripts');
    expect(source?.run).toContain('refs/tags/v$GUARD_VERSION');
    expect(source?.run).toContain('fetched_commit" != "$GUARD_COMMIT"');
    expect(source?.run).toContain('rev-parse');
    expect(source?.run).toContain('CODAPULT_GUARD_VERSION');
    expect(verify?.run).toContain('--no-project-checks');
    expect(verify?.run).toContain('--policy-base "$BASE_SHA"');
    expect(verify?.run).toContain('--fail-on-policy-change');
    expect(verify?.run).toContain('--fail-on-protected-changes');
    expect(verify?.run).toContain('$RUNNER_TEMP/codapult-guard-source/dist/cli/index.js');
    expect(steps.some((step) => /\bnpm install(?:\s|$)/m.test(step.run ?? ''))).toBe(false);
    expect(workflow.jobs?.verify.permissions).toEqual({ contents: 'read' });
  });

  it('pins the reviewed v7 artifact actions by their published full commit SHAs', () => {
    const uses = Object.values(workflow.jobs ?? {}).flatMap((job) =>
      (job.steps ?? []).map((step) => step.uses).filter((value): value is string => Boolean(value)),
    );

    expect(uses).toContain('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1');
    expect(uses).toContain('actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9');
    expect(uses).toContain('actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333');
  });

  it('pins all external actions to full commit SHAs', () => {
    for (const job of Object.values(workflow.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (step.uses) expect(step.uses).toMatch(/@[a-f0-9]{40}\b/i);
      }
    }
  });
});
