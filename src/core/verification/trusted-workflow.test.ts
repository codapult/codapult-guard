import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

interface TrustedWorkflow {
  on?: { workflow_run?: { workflows?: string[]; types?: string[] } };
  jobs?: Record<
    string,
    {
      if?: string;
      needs?: string | string[];
      outputs?: Record<string, string>;
      permissions?: Record<string, string>;
      steps?: { uses?: string; run?: string; with?: Record<string, string | boolean> }[];
    }
  >;
}

const workflow = parse(
  readFileSync(new URL('../../../docs/guard-trusted-pr-attestation.yml', import.meta.url), 'utf8'),
) as TrustedWorkflow;

function scriptFor(stepName: string): string {
  const step = workflow.jobs?.inspect.steps?.find((candidate) => candidate.run?.includes(stepName));
  const script = step?.run?.match(/node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE/)?.[1];
  if (!script) throw new Error(`Could not find embedded Node script for ${stepName}`);
  return script;
}

function runEmbeddedScript(
  script: string,
  files: Record<string, string>,
  extraEnv: Record<string, string> = {},
) {
  const appended: Record<string, string> = {};
  const source = script.replace(/^import \{ appendFileSync, readFileSync \} from 'node:fs';\n/, '');
  try {
    runInNewContext(source, {
      process: { env: extraEnv },
      readFileSync: (path: string) => {
        const name = String(path).split('/').at(-1) ?? '';
        if (!(name in files)) throw new Error(`No test file mapped for ${name}`);
        return files[name];
      },
      appendFileSync: (path: string, value: string) => {
        const name = String(path).split('/').at(-1) ?? '';
        appended[name] = (appended[name] ?? '') + value;
      },
    });
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
  return appended;
}

const contextScript = scriptFor('pullRequests.length');
const receiptScript = workflow.jobs?.verify.steps
  ?.find((step) => step.run?.includes('Guard receipt does not match'))
  ?.run?.match(/node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE/)?.[1];
if (!receiptScript) throw new Error('Could not find embedded receipt validation script');

function prEvent(
  options: { count?: number; headRepository?: string; baseRepository?: string } = {},
) {
  const pullRequest = {
    number: 42,
    head: {
      sha: 'a'.repeat(40),
      repo: { full_name: options.headRepository ?? 'contributor/project' },
    },
    base: { sha: 'b'.repeat(40), repo: { full_name: options.baseRepository ?? 'owner/project' } },
  };
  return {
    repository: { full_name: options.baseRepository ?? 'owner/project' },
    workflow_run: {
      head_repository: { full_name: options.headRepository ?? 'contributor/project' },
      pull_requests: Array.from({ length: options.count ?? 1 }, () => pullRequest),
    },
  };
}

function runContext(event: unknown) {
  return runEmbeddedScript(
    contextScript,
    { 'event.json': JSON.stringify(event) },
    { EVENT_PATH: 'event.json', GITHUB_OUTPUT: 'output.txt' },
  )['output.txt'];
}

function receiptFiles(
  overrides: { outcome?: string; headSha?: string; baseSha?: string; statement?: unknown } = {},
) {
  const fingerprint = 'c'.repeat(64);
  const receipt = {
    outcome: overrides.outcome ?? 'pass',
    runId: 'run-123',
    subject: {
      headSha: overrides.headSha ?? 'a'.repeat(40),
      baseSha: overrides.baseSha ?? 'b'.repeat(40),
    },
    verificationScope: { complete: true, stable: true, fingerprint },
  };
  const statement = overrides.statement ?? {
    predicate: { receipt: { runId: 'run-123' } },
    subject: [{ digest: { sha256: fingerprint } }],
  };
  return {
    'guard-verification.json': JSON.stringify({
      outcome: overrides.outcome ?? 'pass',
      run: { receipt },
    }),
    'guard-verification.intoto.json': JSON.stringify(statement),
  };
}

describe('trusted PR attestation workflow template', () => {
  it('runs from workflow_run after the ordinary Guard PR workflow', () => {
    expect(workflow.on?.workflow_run).toEqual({ workflows: ['Guard'], types: ['completed'] });
  });

  it('keeps OIDC signing separate from the verifier that reads PR files', () => {
    expect(workflow.jobs?.verify.permissions).toEqual({ contents: 'read' });
    expect(workflow.jobs?.attest.needs).toEqual(['inspect', 'verify']);
    expect(workflow.jobs?.attest.permissions).toMatchObject({
      'id-token': 'write',
      attestations: 'write',
      'artifact-metadata': 'write',
    });
  });

  it('routes fork PRs around checkout and signing and explains the skipped attestation', () => {
    expect(workflow.jobs?.verify.needs).toBe('inspect');
    expect(workflow.jobs?.verify.if).toContain("needs.inspect.outputs.fork != 'true'");
    expect(workflow.jobs?.['fork-pr-summary'].needs).toBe('inspect');
    expect(workflow.jobs?.['fork-pr-summary'].if).toContain("needs.inspect.outputs.fork == 'true'");
    expect(workflow.jobs?.attest.needs).toEqual(['inspect', 'verify']);
    expect(workflow.jobs?.attest.if).toContain("needs.inspect.outputs.fork != 'true'");
    expect(workflow.jobs?.['fork-pr-summary'].steps?.[0]?.run).toContain(
      'did not create a signed attestation',
    );
    expect(workflow.jobs?.attest.if).toContain("needs.verify.result == 'success'");
    expect(workflow.jobs?.attest.if).toContain("needs.verify.outputs.attestation == 'true'");
  });

  it('identifies a valid fork PR without checking out its code', () => {
    expect(runContext(prEvent())).toContain('fork=true');
    expect(workflow.jobs?.verify.if).toContain("needs.inspect.outputs.fork != 'true'");
  });

  it('summarizes an unattached fork run using trusted repository metadata', () => {
    expect(runContext(prEvent({ count: 0 }))).toBe('fork=true\n');
    expect(workflow.jobs?.['fork-pr-summary'].if).toContain("needs.inspect.outputs.fork == 'true'");
  });

  it('allows the trusted workflow to inspect a same-repository PR', () => {
    const event = prEvent({ headRepository: 'owner/project', baseRepository: 'owner/project' });
    expect(runContext(event)).toContain('fork=false');
  });

  it.each([0, 2])(
    'fails closed when the workflow_run event contains %i associated PRs',
    (count) => {
      const sameRepositoryEvent = prEvent({
        count,
        headRepository: 'owner/project',
        baseRepository: 'owner/project',
      });
      expect(() => runContext(sameRepositoryEvent)).toThrow();
    },
  );

  it('fails closed when PR repository identity is missing', () => {
    const event = prEvent();
    event.workflow_run.pull_requests[0]!.head.repo.full_name = undefined as never;
    expect(() => runContext(event)).toThrow();
  });

  it('accepts a passing receipt bound to the expected PR head and base', () => {
    const output = runEmbeddedScript(receiptScript, receiptFiles(), {
      BASE_SHA: 'b'.repeat(40),
      HEAD_SHA: 'a'.repeat(40),
      GITHUB_OUTPUT: 'output.txt',
    });
    expect(output['output.txt']).toBe('attestation=true\n');
  });

  it.each([
    ['head SHA', { headSha: 'd'.repeat(40) }],
    ['base SHA', { baseSha: 'd'.repeat(40) }],
    ['failed Guard outcome', { outcome: 'fail' }],
    [
      'statement for another receipt',
      {
        statement: {
          predicate: { receipt: { runId: 'other' } },
          subject: [{ digest: { sha256: 'c'.repeat(64) } }],
        },
      },
    ],
    ['malformed statement', { statement: { predicate: {}, subject: [] } }],
  ])('refuses attestation for %s', (_case, overrides) => {
    expect(() =>
      runEmbeddedScript(receiptScript, receiptFiles(overrides), {
        BASE_SHA: 'b'.repeat(40),
        HEAD_SHA: 'a'.repeat(40),
        GITHUB_OUTPUT: 'output.txt',
      }),
    ).toThrow();
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
