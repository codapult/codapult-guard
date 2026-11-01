import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

interface ConsumerWorkflow {
  jobs?: Record<
    string,
    {
      steps?: {
        name?: string;
        run?: string;
        if?: string;
        with?: Record<string, string>;
        env?: Record<string, string>;
      }[];
    }
  >;
}

const workflow = parse(
  readFileSync(new URL('../../../docs/guard-ci.yml', import.meta.url), 'utf8'),
) as ConsumerWorkflow;

describe('consumer CI workflow template', () => {
  it('checks the PR merge tree while loading policy from the base ref', () => {
    const steps = workflow.jobs?.guard.steps ?? [];
    const checkout = steps.find((step) => step.name === 'Checkout');
    const verify = steps.find((step) => step.name === 'Verify Guard and project checks');
    const summary = steps.find((step) => step.name === 'Add Guard result to the workflow summary');
    const receipt = steps.find((step) => step.name === 'Upload verification receipt');
    const sarifExport = steps.find((step) => step.name === 'Export Guard findings as SARIF');
    const sarifUpload = steps.find((step) => step.name === 'Upload Guard findings');

    expect(checkout?.with?.ref).toBe('${{ github.sha }}');
    expect(verify?.run).toContain('--policy-base "$POLICY_BASE"');
    expect(verify?.env?.GUARD_RESULT_FILE).toBe('${{ runner.temp }}/guard-verification.json');
    expect(verify?.env?.GUARD_STATEMENT_FILE).toBe(
      '${{ runner.temp }}/guard-verification.intoto.json',
    );
    expect(verify?.run).toContain('> "$GUARD_RESULT_FILE"');
    expect(summary?.if).toBe('always()');
    expect(summary?.env?.GUARD_RESULT_FILE).toBe('${{ runner.temp }}/guard-verification.json');
    expect(receipt?.with?.path).toContain('${{ runner.temp }}/guard-verification.json');
    expect(sarifExport?.env?.GUARD_SARIF_FILE).toBe('${{ runner.temp }}/guard-results.sarif');
    expect(sarifExport?.run).toContain('> "$GUARD_SARIF_FILE"');
    expect(sarifUpload?.with?.sarif_file).toBe('${{ runner.temp }}/guard-results.sarif');
  });

  it('uses the review command default JSON output in the artifact packet', () => {
    const steps = workflow.jobs?.guard.steps ?? [];
    const review = steps.find((step) => step.name === 'Prepare PR review packet');
    const upload = steps.find((step) => step.name === 'Upload PR review packet');

    expect(review?.run).toContain('codapult-guard review --base');
    expect(review?.run).not.toContain('--json');
    expect(review?.run).toContain('> "$GUARD_REVIEW_FILE"');
    expect(review?.env?.GUARD_REVIEW_FILE).toBe('${{ runner.temp }}/guard-review.json');
    expect(upload?.with?.path).toBe('${{ runner.temp }}/guard-review.json');
  });
});
