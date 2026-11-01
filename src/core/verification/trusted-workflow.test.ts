import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

interface TrustedWorkflow {
  on?: { pull_request_target?: { types?: string[] } };
  permissions?: Record<string, string>;
  jobs?: Record<
    string,
    {
      name?: string;
      if?: string;
      needs?: string | string[];
      outputs?: Record<string, string>;
      permissions?: Record<string, string>;
      steps?: {
        name?: string;
        if?: string;
        uses?: string;
        run?: string;
        env?: Record<string, string>;
        with?: Record<string, string | boolean>;
      }[];
    }
  >;
}

interface GuardCiWorkflow {
  jobs?: Record<
    string,
    {
      steps?: {
        name?: string;
        run?: string;
        env?: Record<string, string>;
      }[];
    }
  >;
}

interface TestReceipt {
  version: number;
  kind: string;
  outcome: string;
  runId: string;
  gate: string;
  subject: { headSha: string; baseSha: string };
  policy: { source: string; ref: string; changedFromBase: boolean };
  policySurface: {
    complete: boolean;
    workflowChanged: boolean;
    changedPaths: string[];
    suppressionMarkers: string[];
  };
  ciIntegrity?: { status: string; workflows: unknown[] };
  verificationScope: {
    algorithm: string;
    complete: boolean;
    stable: boolean;
    fingerprint: string;
  };
}

const workflow = parse(
  readFileSync(new URL('../../../docs/guard-trusted-pr-attestation.yml', import.meta.url), 'utf8'),
) as TrustedWorkflow;
const ciWorkflow = parse(
  readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
) as GuardCiWorkflow;

function embeddedScript(jobName: string, marker: string): string {
  const step = workflow.jobs?.[jobName]?.steps?.find((candidate) => candidate.run?.includes(marker));
  const script = step?.run?.match(/node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE/)?.[1];
  if (!script) throw new Error(`Could not find embedded Node script for ${marker}`);
  return script;
}

function runEmbeddedScript(
  script: string,
  files: Record<string, string>,
  extraEnv: Record<string, string> = {},
): Record<string, string> {
  const appended: Record<string, string> = {};
  const source = script.replace(/^import \{[^}]+\} from 'node:fs';\n/, '');
  runInNewContext(source, {
    process: { env: extraEnv },
    readFileSync: (path: string) => {
      const name = path.split('/').at(-1) ?? '';
      if (!(name in files)) throw new Error(`No test file mapped for ${name}`);
      return files[name];
    },
    appendFileSync: (path: string, value: string) => {
      const name = path.split('/').at(-1) ?? '';
      appended[name] = (appended[name] ?? '') + value;
    },
    rmSync: () => undefined,
  });
  return appended;
}

const contextScript = embeddedScript('inspect', 'Pull request number');
const receiptScript = embeddedScript('verify', 'Guard did not pass');

function pullRequestEvent(options: {
  number?: number;
  headSha?: string;
  baseSha?: string;
  headRepository?: string;
  baseRepository?: string;
  eventRepository?: string;
} = {}) {
  const baseRepository = options.baseRepository ?? 'owner/project';
  return {
    repository: { full_name: options.eventRepository ?? baseRepository },
    pull_request: {
      number: options.number ?? 42,
      head: {
        sha: options.headSha ?? 'a'.repeat(40),
        repo: { full_name: options.headRepository ?? 'contributor/project' },
      },
      base: { sha: options.baseSha ?? 'b'.repeat(40), repo: { full_name: baseRepository } },
    },
  };
}

function runContext(event: unknown): string | undefined {
  return runEmbeddedScript(
    contextScript,
    { 'event.json': JSON.stringify(event) },
    { EVENT_PATH: 'event.json', GITHUB_OUTPUT: 'output.txt' },
  )['output.txt'];
}

function receiptEnvironment(mode = 'strict'): Record<string, string> {
  return {
    BASE_SHA: 'b'.repeat(40),
    HEAD_SHA: 'a'.repeat(40),
    GUARD_POLICY_MODE: mode,
    GUARD_RESULT_FILE: 'guard-verification.json',
    GUARD_STATEMENT_FILE: 'guard-verification.intoto.json',
    GITHUB_OUTPUT: 'output.txt',
    GITHUB_STEP_SUMMARY: 'summary.txt',
  };
}

function testReceipt(overrides: {
  outcome?: string;
  headSha?: string;
  baseSha?: string;
  receiptVersion?: number;
  scopeAlgorithm?: string;
  policySource?: string;
  policyRef?: string;
  policyChanged?: boolean;
  surfaceComplete?: boolean;
  changedPaths?: string[];
  workflowChanged?: boolean;
  suppressionMarkers?: string[];
  ciStatus?: string;
  noCiIntegrity?: boolean;
} = {}): TestReceipt {
  return {
    version: overrides.receiptVersion ?? 1,
    kind: 'verification-receipt',
    outcome: overrides.outcome ?? 'pass',
    runId: 'run-123',
    gate: 'none',
    subject: {
      headSha: overrides.headSha ?? 'a'.repeat(40),
      baseSha: overrides.baseSha ?? 'b'.repeat(40),
    },
    policy: {
      source: overrides.policySource ?? 'git-ref',
      ref: overrides.policyRef ?? 'b'.repeat(40),
      changedFromBase: overrides.policyChanged ?? false,
    },
    policySurface: {
      complete: overrides.surfaceComplete ?? true,
      workflowChanged: overrides.workflowChanged ?? false,
      changedPaths: overrides.changedPaths ?? [],
      suppressionMarkers: overrides.suppressionMarkers ?? [],
    },
    ...(overrides.noCiIntegrity
      ? {}
      : { ciIntegrity: { status: overrides.ciStatus ?? 'ok', workflows: [{ path: '.github/workflows/guard.yml' }] } }),
    verificationScope: {
      algorithm: overrides.scopeAlgorithm ?? 'sha256',
      complete: true,
      stable: true,
      fingerprint: 'c'.repeat(64),
    },
  };
}

function statementFor(receipt: TestReceipt) {
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [
      {
        name: 'codapult-guard:verification-context',
        digest: { sha256: receipt.verificationScope.fingerprint },
      },
    ],
    predicateType: 'https://codapult.dev/attestations/guard-verification/v1',
    predicate: { receipt },
  };
}

function receiptFiles(overrides: Parameters<typeof testReceipt>[0] = {}) {
  const receipt = testReceipt(overrides);
  return {
    'guard-verification.json': JSON.stringify({
      outcome: overrides.outcome ?? 'pass',
      run: { receipt },
    }),
    'guard-verification.intoto.json': JSON.stringify(statementFor(receipt)),
  };
}

describe('trusted PR verification workflow template', () => {
  it('runs a checksum-verified actionlint on shipped workflow templates in package CI', () => {
    const steps = ciWorkflow.jobs?.actionlint?.steps ?? [];
    const install = steps.find((step) => step.name === 'Install verified actionlint binary');
    const lint = steps.find((step) => step.name === 'Lint repository workflows and distributed templates');

    expect(install?.env?.ACTIONLINT_VERSION).toBe('1.7.12');
    expect(install?.env?.ACTIONLINT_SHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(install?.run).toContain('sha256sum --check');
    expect(lint?.run).toContain('docs/guard-ci.yml');
    expect(lint?.run).toContain('docs/guard-trusted-pr-attestation.yml');
  });

  it('uses the default-branch workflow source and exposes a stable required job', () => {
    expect(workflow.on?.pull_request_target).toBeDefined();
    expect(readFileSync(new URL('../../../docs/guard-trusted-pr-attestation.yml', import.meta.url), 'utf8'))
      .toContain("repository's default branch");
    expect(workflow.on?.pull_request_target?.types).toEqual([
      'opened',
      'synchronize',
      'reopened',
      'ready_for_review',
      'edited',
    ]);
    expect(workflow.jobs?.verify.name).toBe('Guard trusted verification');
    expect(workflow.jobs?.verify.if).toBe("needs.inspect.result == 'success'");
  });

  it('verifies both same-repository and fork PRs using base-branch policy', () => {
    expect(workflow.jobs?.verify.needs).toBe('inspect');
    expect(workflow.jobs?.verify.if).not.toContain('fork');
    expect(workflow.jobs?.verify.steps?.[0]?.with?.ref).toBe(
      'refs/pull/${{ needs.inspect.outputs.number }}/head',
    );
    expect(workflow.jobs?.verify.steps?.find((step) => step.run?.includes('--policy-base'))?.run)
      .toContain('--policy-base "$BASE_SHA"');
    expect(workflow.jobs?.['fork-pr-summary'].needs).toEqual(['inspect', 'verify']);
    expect(workflow.jobs?.['fork-pr-summary'].steps?.[0]?.run).toContain(
      'checked this PR\'s exact head and base revisions',
    );
  });

  it('reads and validates exact PR identity and SHAs from the pull_request_target event', () => {
    expect(runContext(pullRequestEvent())).toBe(
      `number=42\nhead_sha=${'a'.repeat(40)}\nbase_sha=${'b'.repeat(40)}\nfork=true\n`,
    );
    expect(runContext(pullRequestEvent({ headRepository: 'owner/project' }))).toContain('fork=false');
    expect(() => runContext({ repository: { full_name: 'owner/project' } })).toThrow();
    expect(() => runContext(pullRequestEvent({ number: 0 }))).toThrow();
    expect(() => runContext(pullRequestEvent({ headSha: 'not-a-sha' }))).toThrow();
    expect(() => runContext(pullRequestEvent({ eventRepository: 'other/project' }))).toThrow();
  });

  it('keeps signing isolated from verification and grants minimum permissions', () => {
    expect(workflow.permissions).toEqual({});
    expect(workflow.jobs?.verify.permissions).toEqual({ contents: 'read' });
    expect(workflow.jobs?.attest.needs).toEqual(['inspect', 'verify']);
    expect(workflow.jobs?.attest.permissions).toEqual({
      contents: 'read',
      'id-token': 'write',
      attestations: 'write',
      'artifact-metadata': 'write',
    });
    expect(workflow.jobs?.attest.if).toContain("needs.inspect.outputs.fork != 'true'");
    expect(workflow.jobs?.attest.if).toContain("needs.verify.outputs.attestation == 'true'");
  });

  it('requires a complete passing CI contract before allowing a receipt', () => {
    expect(() =>
      runEmbeddedScript(receiptScript, receiptFiles({ noCiIntegrity: true }), receiptEnvironment('host-review')),
    ).toThrow('complete, passing GitHub Actions integrity contract');
    expect(() =>
      runEmbeddedScript(receiptScript, receiptFiles({ ciStatus: 'incomplete' }), receiptEnvironment('host-review')),
    ).toThrow('complete, passing GitHub Actions integrity contract');
    expect(() =>
      runEmbeddedScript(
        receiptScript,
        receiptFiles({ ciStatus: 'policy-weakened', outcome: 'policy-weakened' }),
        receiptEnvironment(),
      ),
    ).toThrow('Guard did not pass');
  });

  it('attests a clean receipt bound to the PR and exact base policy', () => {
    const output = runEmbeddedScript(receiptScript, receiptFiles(), receiptEnvironment());
    expect(output['output.txt']).toBe('attestation=true\n');
  });

  it.each([
    ['head SHA', { headSha: 'd'.repeat(40) }],
    ['base SHA', { baseSha: 'd'.repeat(40) }],
    ['policy source', { policySource: 'working-tree' }],
    ['policy base ref', { policyRef: 'd'.repeat(40) }],
    ['unknown schema', { receiptVersion: 2 }],
    ['unknown scope hash', { scopeAlgorithm: 'sha1' }],
    ['incomplete policy surface', { surfaceComplete: false }],
  ])('refuses attestation for invalid %s', (_case, overrides) => {
    expect(() =>
      runEmbeddedScript(receiptScript, receiptFiles(overrides), receiptEnvironment()),
    ).toThrow();
  });

  it.each([
    ['policy file change', { policyChanged: true }],
    ['protected path change', { changedPaths: ['.github/workflows/guard.yml'] }],
    ['workflow change', { workflowChanged: true }],
    ['new suppression', { suppressionMarkers: ['src/file.ts:eslint-disable'] }],
  ])('blocks %s in strict mode and withholds its statement in host-review mode', (_case, overrides) => {
    expect(() =>
      runEmbeddedScript(receiptScript, receiptFiles(overrides), receiptEnvironment('strict')),
    ).toThrow('Strict policy mode');

    const output = runEmbeddedScript(
      receiptScript,
      receiptFiles(overrides),
      receiptEnvironment('host-review'),
    );
    expect(output['output.txt']).toBe('attestation=false\n');
    expect(output['summary.txt']).toContain('Host review: **required**');
  });

  it('uploads a statement only for a clean same-repository PR', () => {
    const upload = workflow.jobs?.verify.steps?.find((step) =>
      step.uses?.startsWith('actions/upload-artifact@'),
    );
    expect(upload?.if).toContain("steps.result.outputs.attestation == 'true'");
    expect(upload?.if).toContain("needs.inspect.outputs.fork != 'true'");
    expect(workflow.jobs?.verify.steps?.find((step) => step.run?.includes('pnpm install --frozen-lockfile'))?.run)
      .toContain('--ignore-scripts');
  });

  it('pins every external action to a full commit SHA', () => {
    const uses = Object.values(workflow.jobs ?? {}).flatMap((job) =>
      (job.steps ?? []).map((step) => step.uses).filter((value): value is string => Boolean(value)),
    );
    for (const action of uses) expect(action).toMatch(/@[a-f0-9]{40}\b/i);
  });
});
