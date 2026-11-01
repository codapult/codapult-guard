import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
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
    expect(verify?.env?.GUARD_POLICY_MODE).toBe(
      "${{ vars.CODAPULT_GUARD_POLICY_MODE || 'host-review' }}",
    );
    expect(verify?.run).toContain('host-review)');
    expect(verify?.run).toContain('strict)');
    expect(verify?.run).toContain('--fail-on-policy-change --fail-on-protected-changes');
    expect(verify?.run).toContain('Unsupported CODAPULT_GUARD_POLICY_MODE');
    expect(verify?.run).not.toContain('--fail-on-policy-change --attestation-out');
    expect(verify?.env?.GUARD_RESULT_FILE).toBe('${{ runner.temp }}/guard-verification.json');
    expect(verify?.env?.GUARD_STATEMENT_FILE).toBe(
      '${{ runner.temp }}/guard-verification.intoto.json',
    );
    expect(verify?.run).toContain('> "$GUARD_RESULT_FILE"');
    expect(summary?.if).toBe('always()');
    expect(summary?.env?.GUARD_RESULT_FILE).toBe('${{ runner.temp }}/guard-verification.json');
    expect(summary?.env?.GUARD_POLICY_MODE).toBe(
      "${{ vars.CODAPULT_GUARD_POLICY_MODE || 'host-review' }}",
    );
    expect(summary?.run).toContain('Host review: **required**');
    const statementGuard = steps.find(
      (step) => step.name === 'Remove statement unless the PR was verified without policy changes',
    );
    expect(statementGuard?.if).toBe("always() && github.event_name == 'pull_request'");
    expect(statementGuard?.run).toContain('result.policyChanged !== true');
    expect(statementGuard?.run).toContain('policySurface?.complete === true');
    expect(statementGuard?.run).toContain('rmSync(statementFile, { force: true })');
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

  it.each([
    ['host-review', false],
    ['strict', true],
  ])('selects the %s policy gate mode at runtime', (mode, strict) => {
    const verify = workflow.jobs?.guard.steps?.find(
      (step) => step.name === 'Verify Guard and project checks',
    );
    expect(verify?.run).toBeDefined();
    if (!verify?.run) return;

    const root = mkdtempSync(join(tmpdir(), 'guard-consumer-mode-'));
    try {
      const captureFile = join(root, 'args.txt');
      const pnpmStub = join(root, 'pnpm');
      writeFileSync(
        pnpmStub,
        '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$GUARD_CAPTURE_ARGS"\nprintf \'{"outcome":"pass"}\\n\'\n',
      );
      chmodSync(pnpmStub, 0o755);

      execFileSync('/bin/bash', ['-e', '-c', verify.run], {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${root}${delimiter}${process.env.PATH ?? ''}`,
          GITHUB_EVENT_NAME: 'pull_request',
          POLICY_BASE: 'base-sha',
          GUARD_POLICY_MODE: mode,
          GUARD_RESULT_FILE: join(root, 'result.json'),
          GUARD_STATEMENT_FILE: join(root, 'statement.json'),
          GUARD_CAPTURE_ARGS: captureFile,
        },
      });

      const args = readFileSync(captureFile, 'utf8');
      expect(args).toContain('--policy-base\nbase-sha');
      expect(args.includes('--fail-on-policy-change')).toBe(strict);
      expect(args.includes('--fail-on-protected-changes')).toBe(strict);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed for an unsupported policy gate mode', () => {
    const verify = workflow.jobs?.guard.steps?.find(
      (step) => step.name === 'Verify Guard and project checks',
    );
    expect(verify?.run).toBeDefined();
    if (!verify?.run) return;

    const root = mkdtempSync(join(tmpdir(), 'guard-consumer-invalid-mode-'));
    try {
      expect(() =>
        execFileSync('/bin/bash', ['-e', '-c', verify.run!], {
          cwd: root,
          env: {
            ...process.env,
            GITHUB_EVENT_NAME: 'pull_request',
            POLICY_BASE: 'base-sha',
            GUARD_POLICY_MODE: 'typo',
            GUARD_RESULT_FILE: join(root, 'result.json'),
            GUARD_STATEMENT_FILE: join(root, 'statement.json'),
          },
          stdio: 'ignore',
        }),
      ).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('marks policy-sensitive runs for host review and removes their statement', () => {
    const steps = workflow.jobs?.guard.steps ?? [];
    const summary = steps.find((step) => step.name === 'Add Guard result to the workflow summary');
    const statementGuard = steps.find(
      (step) => step.name === 'Remove statement unless the PR was verified without policy changes',
    );
    const summaryScript = summary?.run?.match(
      /^node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE\n?$/,
    )?.[1];
    const statementScript = statementGuard?.run?.match(
      /^node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE\n?$/,
    )?.[1];
    expect(summaryScript).toBeDefined();
    expect(statementScript).toBeDefined();
    if (!summaryScript || !statementScript) return;

    const root = mkdtempSync(join(tmpdir(), 'guard-consumer-summary-'));
    try {
      const resultFile = join(root, 'result.json');
      const statementFile = join(root, 'statement.json');
      const summaryFile = join(root, 'summary.md');
      writeFileSync(
        resultFile,
        JSON.stringify({
          outcome: 'pass',
          policyChanged: true,
          run: {
            gate: 'none',
            runId: 'test-run',
            receipt: {
              subject: { changedFiles: ['.codapult/guard/rules.json'] },
              findings: { total: 0, errors: 0, warnings: 0 },
              contractIssues: [],
              tool: { version: '0.11.0' },
              verificationScope: { complete: true, stable: true, files: [] },
            },
          },
          policySurface: {
            complete: true,
            changedPaths: ['.codapult/guard/rules.json'],
            changes: [],
            suppressionMarkers: [],
          },
        }),
      );
      writeFileSync(statementFile, 'unsigned statement');

      execFileSync(process.execPath, ['--input-type=module', '--eval', summaryScript], {
        env: {
          ...process.env,
          GUARD_RESULT_FILE: resultFile,
          GUARD_POLICY_MODE: 'host-review',
          GITHUB_STEP_SUMMARY: summaryFile,
        },
      });
      execFileSync(process.execPath, ['--input-type=module', '--eval', statementScript], {
        env: {
          ...process.env,
          GUARD_RESULT_FILE: resultFile,
          GUARD_STATEMENT_FILE: statementFile,
        },
      });

      expect(readFileSync(summaryFile, 'utf8')).toContain('Host review: **required**');
      expect(() => readFileSync(statementFile, 'utf8')).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves the statement for a passing PR with a complete unchanged policy surface', () => {
    const statementGuard = workflow.jobs?.guard.steps?.find(
      (step) => step.name === 'Remove statement unless the PR was verified without policy changes',
    );
    const script = statementGuard?.run?.match(
      /^node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE\n?$/,
    )?.[1];
    expect(script).toBeDefined();
    if (!script) return;

    const root = mkdtempSync(join(tmpdir(), 'guard-consumer-clean-statement-'));
    try {
      const resultFile = join(root, 'result.json');
      const statementFile = join(root, 'statement.json');
      writeFileSync(
        resultFile,
        JSON.stringify({
          outcome: 'pass',
          policyChanged: false,
          run: {
            receipt: {
              subject: { changedFiles: [] },
              findings: { total: 0, errors: 0, warnings: 0 },
              contractIssues: [],
              tool: { version: '0.11.0' },
              verificationScope: { complete: true, stable: true, files: [] },
            },
          },
          policySurface: { complete: true, changedPaths: [], suppressionMarkers: [] },
        }),
      );
      writeFileSync(statementFile, 'passing statement');

      execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
        env: {
          ...process.env,
          GUARD_RESULT_FILE: resultFile,
          GUARD_STATEMENT_FILE: statementFile,
        },
      });

      expect(readFileSync(statementFile, 'utf8')).toBe('passing statement');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['missing', 'malformed'])('removes the statement when the PR result is %s', (state) => {
    const statementGuard = workflow.jobs?.guard.steps?.find(
      (step) => step.name === 'Remove statement unless the PR was verified without policy changes',
    );
    const script = statementGuard?.run?.match(
      /^node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE\n?$/,
    )?.[1];
    expect(script).toBeDefined();
    if (!script) return;

    const root = mkdtempSync(join(tmpdir(), 'guard-consumer-missing-result-'));
    try {
      const resultFile = join(root, 'result.json');
      const statementFile = join(root, 'statement.json');
      if (state === 'malformed') writeFileSync(resultFile, '{');
      writeFileSync(statementFile, 'untrusted statement');

      execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
        env: {
          ...process.env,
          GUARD_RESULT_FILE: resultFile,
          GUARD_STATEMENT_FILE: statementFile,
        },
      });

      expect(() => readFileSync(statementFile, 'utf8')).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
