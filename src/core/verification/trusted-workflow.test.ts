import { createHash } from 'node:crypto';
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
  on?: {
    pull_request?: unknown;
    merge_group?: { types?: string[] };
    push?: unknown;
  };
  jobs?: Record<
    string,
    {
      steps?: {
        name?: string;
        if?: string;
        uses?: string;
        run?: string;
        env?: Record<string, string>;
      }[];
    }
  >;
}

interface TrustedMergeGroupWorkflow {
  on?: { merge_group?: { types?: string[] } };
  permissions?: Record<string, string>;
  jobs?: Record<
    string,
    {
      name?: string;
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

interface TestReceipt {
  version: number;
  kind: string;
  outcome: string;
  runId: string;
  gate: string;
  requiredStages: string[];
  incompleteStages: string[];
  stages: Record<string, string>;
  subject: {
    repository: string;
    commit: string;
    headSha: string;
    baseSha: string;
    baseCommit: string;
  };
  policy: { fingerprint: string; source: string; ref: string; changedFromBase: boolean };
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
    source: {
      repository: string | null;
      commit: string | null;
      headSha: string | null;
      baseSha: string | null;
      baseCommit: string | null;
    };
    files: { path: string; status: string; sha256?: string }[];
  };
  tool: { name: string; version: string };
}

const workflow = parse(
  readFileSync(new URL('../../../docs/guard-trusted-pr-attestation.yml', import.meta.url), 'utf8'),
) as TrustedWorkflow;
const ciWorkflow = parse(
  readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
) as GuardCiWorkflow;
const guardCiTemplate = parse(
  readFileSync(new URL('../../../docs/guard-ci.yml', import.meta.url), 'utf8'),
) as GuardCiWorkflow;
const trustedMergeGroupWorkflow = parse(
  readFileSync(new URL('../../../docs/guard-trusted-merge-group.yml', import.meta.url), 'utf8'),
) as TrustedMergeGroupWorkflow;
const guardVersion = (
  JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

function embeddedScript(
  jobName: string,
  marker: string,
  sourceWorkflow: TrustedWorkflow | TrustedMergeGroupWorkflow = workflow,
): string {
  const step = sourceWorkflow.jobs?.[jobName]?.steps?.find((candidate) =>
    candidate.run?.includes(marker),
  );
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
  const written: Record<string, string> = {};
  const source = script.replace(/^import \{[^}]+\} from 'node:(?:fs|crypto)';\n/gm, '');
  runInNewContext(source, {
    process: { env: extraEnv },
    createHash,
    Buffer,
    readFileSync: (path: string) => {
      const name = path.split('/').at(-1) ?? '';
      if (!(name in files)) throw new Error(`No test file mapped for ${name}`);
      return files[name];
    },
    appendFileSync: (path: string, value: string) => {
      const name = path.split('/').at(-1) ?? '';
      appended[name] = (appended[name] ?? '') + value;
    },
    writeFileSync: (path: string, value: string) => {
      const name = path.split('/').at(-1) ?? '';
      written[name] = value;
    },
    rmSync: () => undefined,
  });
  return { ...written, ...appended };
}

const contextScript = embeddedScript('inspect', 'Pull request number');
const receiptScript = embeddedScript('verify', 'Guard did not pass');
const mergeGroupContextScript = embeddedScript(
  'verify',
  'Merge-group event, repository',
  trustedMergeGroupWorkflow,
);
const mergeGroupReceiptScript = embeddedScript(
  'verify',
  'Guard did not pass',
  trustedMergeGroupWorkflow,
);

function pullRequestEvent(
  options: {
    number?: number;
    headSha?: string;
    baseSha?: string;
    headRepository?: string;
    baseRepository?: string;
    eventRepository?: string;
  } = {},
): {
  repository: { full_name: string };
  pull_request: {
    number: number;
    head: { sha: string; repo: { full_name: string } };
    base: { sha: string; repo: { full_name: string } };
  };
} {
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
    GITHUB_REPOSITORY: 'codapult/example',
    GUARD_POLICY_MODE: mode,
    GUARD_VERSION: guardVersion,
    GUARD_RESULT_FILE: 'guard-verification.json',
    GUARD_STATEMENT_FILE: 'guard-verification.intoto.json',
    GITHUB_OUTPUT: 'output.txt',
    GITHUB_STEP_SUMMARY: 'summary.txt',
  };
}

function testReceipt(
  overrides: {
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
    toolVersion?: string;
    scopeFiles?: TestReceipt['verificationScope']['files'];
    requiredStages?: string[];
    incompleteStages?: string[];
    stages?: Record<string, string>;
  } = {},
): TestReceipt {
  const policyFingerprint = 'd'.repeat(64);
  const tool = { name: '@codapult/guard', version: overrides.toolVersion ?? guardVersion };
  const files: TestReceipt['verificationScope']['files'] = overrides.scopeFiles ?? [
    { path: 'src/example.ts', status: 'present', sha256: 'e'.repeat(64) },
    { path: 'src/removed.ts', status: 'deleted' },
  ];
  const source = {
    repository: 'codapult/example',
    commit: overrides.headSha ?? 'a'.repeat(40),
    headSha: overrides.headSha ?? 'a'.repeat(40),
    baseSha: overrides.baseSha ?? 'b'.repeat(40),
    baseCommit: overrides.baseSha ?? 'b'.repeat(40),
  };
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        algorithm: 'sha256',
        policyFingerprint,
        tool,
        files,
        source: {
          repository: source.repository,
          commit: source.commit,
          headSha: source.headSha,
          baseSha: source.baseSha,
          baseCommit: source.baseCommit,
        },
      }),
      'utf8',
    )
    .digest('hex');
  return {
    version: overrides.receiptVersion ?? 1,
    kind: 'verification-receipt',
    outcome: overrides.outcome ?? 'pass',
    runId: 'run-123',
    gate: 'none',
    requiredStages: overrides.requiredStages ?? ['verification-scope'],
    incompleteStages: overrides.incompleteStages ?? [],
    stages: overrides.stages ?? { 'verification-scope': 'ok' },
    subject: {
      repository: 'codapult/example',
      commit: overrides.headSha ?? 'a'.repeat(40),
      headSha: overrides.headSha ?? 'a'.repeat(40),
      baseSha: overrides.baseSha ?? 'b'.repeat(40),
      baseCommit: overrides.baseSha ?? 'b'.repeat(40),
    },
    policy: {
      fingerprint: policyFingerprint,
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
      : {
          ciIntegrity: {
            status: overrides.ciStatus ?? 'ok',
            workflows: [{ path: '.github/workflows/guard.yml' }],
          },
        }),
    verificationScope: {
      algorithm: overrides.scopeAlgorithm ?? 'sha256',
      complete: true,
      stable: true,
      fingerprint,
      source,
      files,
    },
    tool,
  };
}

function statementFor(receipt: TestReceipt): {
  _type: string;
  subject: { name: string; digest: { sha256: string } }[];
  predicateType: string;
  predicate: { receipt: TestReceipt };
} {
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [
      {
        name: 'codapult-guard:verification-context',
        digest: { sha256: receipt.verificationScope.fingerprint },
      },
      ...receipt.verificationScope.files.flatMap((file) =>
        file.status === 'present' && file.sha256
          ? [{ name: `file:${file.path}`, digest: { sha256: file.sha256 } }]
          : [],
      ),
    ],
    predicateType:
      'https://github.com/codapult/codapult-guard/blob/main/docs/attestations/guard-verification-v1.md',
    predicate: { receipt },
  };
}

function receiptFiles(overrides: Parameters<typeof testReceipt>[0] = {}): Record<string, string> {
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
    const steps = ciWorkflow.jobs?.actionlint.steps ?? [];
    const install = steps.find((step) => step.name === 'Install verified actionlint binary');
    const lint = steps.find(
      (step) => step.name === 'Lint repository workflows and distributed templates',
    );

    expect(install?.env?.ACTIONLINT_VERSION).toBe('1.7.12');
    expect(install?.env?.ACTIONLINT_SHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(install?.run).toContain('sha256sum --check');
    expect(lint?.run).toContain('docs/guard-ci.yml');
    expect(lint?.run).toContain('docs/guard-trusted-pr-attestation.yml');
    expect(lint?.run).toContain('docs/guard-trusted-merge-group.yml');
  });

  it('triggers the consumer Guard check for the exact merge-group event and uses queue-base policy', () => {
    expect(guardCiTemplate.on?.merge_group?.types).toEqual(['checks_requested']);
    const steps = guardCiTemplate.jobs?.guard.steps ?? [];
    const checkoutValidation = steps.find(
      (step) => step.name === 'Validate exact merge-group candidate and base',
    );
    const dependencyGate = steps.find(
      (step) => step.name === 'Verify Guard runtime dependencies against base',
    );
    const verify = steps.find((step) => step.name === 'Verify Guard and project checks');

    expect(checkoutValidation?.if).toBe("github.event_name == 'merge_group'");
    expect(checkoutValidation?.env?.HEAD_SHA).toContain('github.event.merge_group.head_sha');
    expect(checkoutValidation?.run).toContain('git cat-file -e "$BASE_SHA^{commit}"');
    expect(dependencyGate?.if).toContain("github.event_name == 'merge_group'");
    expect(dependencyGate?.env?.BASE_SHA).toContain('github.event.merge_group.base_sha');
    expect(dependencyGate?.run).toContain('diff_range="$BASE_SHA..HEAD"');
    expect(verify?.env?.POLICY_BASE).toContain('github.event.merge_group.base_sha');
    expect(verify?.run).toContain('never execute project-owned scripts here');
    expect(verify?.run).toContain('--policy-base "$POLICY_BASE"');
    expect(verify?.run).toContain('--no-project-checks --tools off');
  });

  it('pins consumer receipt uploads to the current Node 24 artifact action release', () => {
    const uploads = (guardCiTemplate.jobs?.guard.steps ?? []).filter((step) =>
      step.uses?.startsWith('actions/upload-artifact@'),
    );

    expect(uploads).toHaveLength(2);
    for (const upload of uploads) {
      expect(upload.uses).toBe('actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9');
    }
  });

  it('ships a read-only trusted merge-group ruleset workflow with no signing permissions', () => {
    expect(trustedMergeGroupWorkflow.on?.merge_group?.types).toEqual(['checks_requested']);
    expect(trustedMergeGroupWorkflow.permissions).toEqual({});
    expect(trustedMergeGroupWorkflow.jobs?.verify.name).toBe(
      'Guard trusted merge-group verification',
    );
    expect(trustedMergeGroupWorkflow.jobs?.verify.permissions).toEqual({ contents: 'read' });
    const uses = Object.values(trustedMergeGroupWorkflow.jobs ?? {}).flatMap((job) =>
      (job.steps ?? []).map((step) => step.uses).filter((value): value is string => Boolean(value)),
    );
    for (const action of uses) expect(action).toMatch(/@[a-f0-9]{40}\b/i);
    const verify = trustedMergeGroupWorkflow.jobs?.verify.steps?.find((step) =>
      step.run?.includes('--policy-base'),
    );
    expect(verify?.run).toContain('--policy-base "$BASE_SHA"');
    expect(verify?.run).toContain('--no-project-checks --tools off');
    expect(verify?.run).toContain('--fail-on-policy-change --fail-on-protected-changes');
    expect(verify?.run).not.toContain('pnpm install');
    expect(
      trustedMergeGroupWorkflow.jobs?.verify.steps?.find(
        (step) => step.name === 'Upload the merge-group verification receipt',
      )?.with?.name,
    ).toBe('guard-merge-group-verification');
  });

  it('validates merge-group action, repository, head SHA, and base SHA before checkout', () => {
    const run = (event: unknown, expectedSha = 'c'.repeat(40)): string | undefined =>
      runEmbeddedScript(
        mergeGroupContextScript,
        { 'event.json': JSON.stringify(event) },
        {
          EVENT_PATH: 'event.json',
          EXPECTED_REPOSITORY: 'owner/project',
          EXPECTED_SHA: expectedSha,
          GITHUB_OUTPUT: 'output.txt',
        },
      )['output.txt'];

    expect(
      run({
        action: 'checks_requested',
        repository: { full_name: 'owner/project' },
        merge_group: { head_sha: 'c'.repeat(40), base_sha: 'b'.repeat(40) },
      }),
    ).toBe(`head_sha=${'c'.repeat(40)}\nbase_sha=${'b'.repeat(40)}\n`);
    expect(() => run({ action: 'checks_requested', merge_group: {} })).toThrow();
    expect(() =>
      run({
        action: 'checks_requested',
        repository: { full_name: 'other/project' },
        merge_group: { head_sha: 'c'.repeat(40), base_sha: 'b'.repeat(40) },
      }),
    ).toThrow();
    expect(() =>
      run({
        action: 'checks_requested',
        repository: { full_name: 'owner/project' },
        merge_group: { head_sha: 'd'.repeat(40), base_sha: 'b'.repeat(40) },
      }),
    ).toThrow();
  });

  it('accepts only a passing receipt bound to the exact merge-group SHA and queue-base policy', () => {
    const headSha = 'c'.repeat(40);
    const baseSha = 'b'.repeat(40);
    const receipt = {
      version: 1,
      kind: 'verification-receipt',
      outcome: 'pass',
      runId: 'run-merge-group',
      subject: { githubEvent: 'merge_group', mergeSha: headSha, baseSha },
      policy: { source: 'git-ref', ref: baseSha, changedFromBase: false },
      policySurface: {
        complete: true,
        workflowChanged: false,
        changedPaths: [],
        suppressionMarkers: [],
      },
      ciIntegrity: { status: 'ok', workflows: [] },
      verificationScope: {
        algorithm: 'sha256',
        complete: true,
        stable: true,
        fingerprint: 'd'.repeat(64),
      },
    };
    const runReceiptCheck = (
      overrides: Record<string, unknown> = {},
      mode = 'strict',
    ): Record<string, string> => {
      const currentReceipt = { ...receipt, ...overrides };
      const subject = { ...receipt.subject, ...((overrides.subject as object | undefined) ?? {}) };
      const policy = { ...receipt.policy, ...((overrides.policy as object | undefined) ?? {}) };
      const resultFile = JSON.stringify({
        outcome: 'pass',
        run: { receipt: { ...currentReceipt, subject, policy } },
      });
      return runEmbeddedScript(
        mergeGroupReceiptScript,
        { 'guard-merge-group-verification.json': resultFile },
        {
          BASE_SHA: baseSha,
          HEAD_SHA: headSha,
          GUARD_POLICY_MODE: mode,
          GUARD_RESULT_FILE: 'guard-merge-group-verification.json',
        },
      );
    };

    expect(runReceiptCheck()).toEqual({});
    expect(() =>
      runReceiptCheck({
        subject: { githubEvent: 'merge_group', mergeSha: 'e'.repeat(40), baseSha },
      }),
    ).toThrow();
    expect(() =>
      runReceiptCheck({
        subject: { githubEvent: 'merge_group', mergeSha: headSha, baseSha: 'e'.repeat(40) },
      }),
    ).toThrow();
    expect(() =>
      runReceiptCheck({
        subject: {
          githubEvent: 'merge_group',
          headSha: 'a'.repeat(40),
          mergeSha: headSha,
          baseSha,
        },
      }),
    ).toThrow();
    expect(() =>
      runReceiptCheck({
        policy: { source: 'git-ref', ref: 'e'.repeat(40), changedFromBase: false },
      }),
    ).toThrow();
    expect(() =>
      runReceiptCheck({ ciIntegrity: { status: 'incomplete', workflows: [] } }),
    ).toThrow();
    expect(() =>
      runReceiptCheck({
        policy: { source: 'git-ref', ref: baseSha, changedFromBase: true },
      }),
    ).toThrow('Strict policy mode');
    expect(() =>
      runReceiptCheck({
        policySurface: {
          complete: false,
          workflowChanged: false,
          changedPaths: [],
          suppressionMarkers: [],
        },
      }),
    ).toThrow('completely inspect');
    expect(() =>
      runReceiptCheck({
        verificationScope: {
          algorithm: 'sha256',
          complete: false,
          stable: true,
          fingerprint: 'd'.repeat(64),
        },
      }),
    ).toThrow('complete, stable');
  });

  it('uses the default-branch workflow source and exposes a stable required job', () => {
    expect(workflow.on?.pull_request_target).toBeDefined();
    expect(
      readFileSync(
        new URL('../../../docs/guard-trusted-pr-attestation.yml', import.meta.url),
        'utf8',
      ),
    ).toContain("repository's default branch");
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
    expect(
      workflow.jobs?.verify.steps?.find((step) => step.run?.includes('--policy-base'))?.run,
    ).toContain('--policy-base "$BASE_SHA"');
    expect(workflow.jobs?.['fork-pr-summary'].needs).toEqual(['inspect', 'verify']);
    expect(workflow.jobs?.['fork-pr-summary'].steps?.[0]?.run).toContain(
      "checked this PR's exact head and base revisions",
    );
  });

  it('reads and validates exact PR identity and SHAs from the pull_request_target event', () => {
    expect(runContext(pullRequestEvent())).toBe(
      `number=42\nhead_sha=${'a'.repeat(40)}\nbase_sha=${'b'.repeat(40)}\nfork=true\n`,
    );
    expect(runContext(pullRequestEvent({ headRepository: 'owner/project' }))).toContain(
      'fork=false',
    );
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
      runEmbeddedScript(
        receiptScript,
        receiptFiles({ noCiIntegrity: true }),
        receiptEnvironment('host-review'),
      ),
    ).toThrow('complete, passing GitHub Actions integrity contract');
    expect(() =>
      runEmbeddedScript(
        receiptScript,
        receiptFiles({ ciStatus: 'incomplete' }),
        receiptEnvironment('host-review'),
      ),
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

  it('requires the receipt tool version to match the pinned Guard package version', () => {
    expect(() =>
      runEmbeddedScript(
        receiptScript,
        receiptFiles({ toolVersion: 'unexpected-version' }),
        receiptEnvironment(),
      ),
    ).toThrow('pinned Guard package');
  });

  it.each([
    [
      'duplicate scope paths',
      [
        { path: 'src/example.ts', status: 'present', sha256: 'e'.repeat(64) },
        { path: 'src/example.ts', status: 'present', sha256: 'f'.repeat(64) },
      ],
    ],
    [
      'unsorted scope paths',
      [
        { path: 'src/z.ts', status: 'present', sha256: 'e'.repeat(64) },
        { path: 'src/a.ts', status: 'present', sha256: 'f'.repeat(64) },
      ],
    ],
  ])('rejects %s before attesting', (_description, scopeFiles) => {
    expect(() =>
      runEmbeddedScript(receiptScript, receiptFiles({ scopeFiles }), receiptEnvironment()),
    ).toThrow('paths must be unique and sorted');
  });

  it.each([
    ['empty required stages', { requiredStages: [], stages: {} }],
    ['missing required scope stage', { requiredStages: ['architecture-policy'] }],
    [
      'unsupported required stage',
      {
        requiredStages: ['verification-scope', 'future-stage'],
        stages: { 'verification-scope': 'ok', 'future-stage': 'ok' },
      },
    ],
    ['head SHA', { headSha: 'd'.repeat(40) }],
    ['base SHA', { baseSha: 'd'.repeat(40) }],
    ['policy source', { policySource: 'working-tree' }],
    ['policy base ref', { policyRef: 'd'.repeat(40) }],
    ['unknown schema', { receiptVersion: 2 }],
    ['unexpected Guard version', { toolVersion: 'unexpected-version' }],
    ['unknown scope hash', { scopeAlgorithm: 'sha1' }],
    [
      'deleted scope path with a previous-content digest',
      {
        scopeFiles: [{ path: 'src/removed.ts', status: 'deleted', sha256: 'f'.repeat(64) }],
      },
    ],
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
  ])(
    'blocks %s in strict mode and withholds its statement in host-review mode',
    (_case, overrides) => {
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
    },
  );

  it('uploads a statement only for a clean same-repository PR', () => {
    const upload = workflow.jobs?.verify.steps?.find((step) =>
      step.uses?.startsWith('actions/upload-artifact@'),
    );
    expect(upload?.if).toContain("steps.result.outputs.attestation == 'true'");
    expect(upload?.if).toContain("needs.inspect.outputs.fork != 'true'");
    expect(
      workflow.jobs?.verify.steps?.find((step) =>
        step.run?.includes('pnpm install --frozen-lockfile'),
      )?.run,
    ).toContain('--ignore-scripts');
  });

  it('signs the Guard predicate and exports DSSE envelopes as one-per-line JSONL', () => {
    const attestSteps = workflow.jobs?.attest.steps ?? [];
    const guardSign = attestSteps.find(
      (step) => step.name === 'Sign the Guard verification predicate',
    );
    const exportStep = attestSteps.find(
      (step) => step.name === 'Export the signed DSSE envelopes as JSONL',
    );
    const upload = attestSteps.find(
      (step) => step.name === 'Upload the signed in-toto JSONL envelope',
    );

    expect(guardSign?.with?.['predicate-type']).toBe(
      'https://github.com/codapult/codapult-guard/blob/main/docs/attestations/guard-verification-v1.md',
    );
    expect(guardSign?.with?.['subject-checksums']).toContain('guard-verification-subjects.sha256');
    expect(exportStep?.run).toContain('dsseEnvelope');
    expect(exportStep?.env?.STATEMENT_PATH).toBe(
      '${{ github.workspace }}/guard-verification.intoto.json',
    );
    expect(upload?.with?.path).toContain('guard-verification.intoto.jsonl');
    expect(upload?.with?.path).toContain('guard-verification.sigstore.jsonl');
  });

  it('enforces GitHub subject-count limits at the signing boundary', () => {
    const prepareStep = workflow.jobs?.attest.steps?.find(
      (step) => step.name === 'Prepare Guard predicate and subject checksums',
    );
    expect(prepareStep?.run).toContain('statement.subject.length > 1_024');
    expect(prepareStep?.run).toContain('GitHub attestation subject limit of 1,024');

    const tooManySubjects = JSON.stringify({
      subject: Array.from({ length: 1_025 }, (_, index) => ({
        name: `file:${index}`,
        digest: { sha256: 'a'.repeat(64) },
      })),
      predicate: { receipt: {} },
    });
    expect(() =>
      runEmbeddedScript(
        embeddedScript('attest', 'GitHub attestation subject limit of 1,024'),
        { 'guard-verification.intoto.json': tooManySubjects },
        {
          STATEMENT_PATH: 'guard-verification.intoto.json',
          PREDICATE_PATH: 'predicate.json',
          SUBJECT_CHECKSUMS_PATH: 'subjects.sha256',
        },
      ),
    ).toThrow('GitHub attestation subject limit of 1,024');
  });

  it('enforces GitHub predicate-size limits at the signing boundary', () => {
    const prepareStep = workflow.jobs?.attest.steps?.find(
      (step) => step.name === 'Prepare Guard predicate and subject checksums',
    );
    expect(prepareStep?.run).toContain("Buffer.byteLength(predicate, 'utf8')");
    expect(prepareStep?.run).toContain('16 * 1024 * 1024');

    const oversizedStatement = JSON.stringify({
      subject: [
        { name: 'codapult-guard:verification-context', digest: { sha256: 'a'.repeat(64) } },
      ],
      predicate: { receipt: { detail: 'x'.repeat(16 * 1024 * 1024) } },
    });
    expect(() =>
      runEmbeddedScript(
        embeddedScript('attest', 'GitHub attestation limit of 16 MiB'),
        { 'guard-verification.intoto.json': oversizedStatement },
        {
          STATEMENT_PATH: 'guard-verification.intoto.json',
          PREDICATE_PATH: 'predicate.json',
          SUBJECT_CHECKSUMS_PATH: 'subjects.sha256',
        },
      ),
    ).toThrow('GitHub attestation limit of 16 MiB');
  });

  it('exports Guard and GitHub provenance DSSE envelopes as separate JSONL records', () => {
    const receipt = testReceipt();
    const statement = statementFor(receipt);
    const statementText = JSON.stringify(statement);
    const statementDigest = createHash('sha256').update(statementText).digest('hex');
    const makeBundle = (payload: unknown) => ({
      mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
      dsseEnvelope: {
        payloadType: 'application/vnd.in-toto+json',
        payload: Buffer.from(JSON.stringify(payload)).toString('base64'),
        signatures: [{ sig: 'test-signature' }],
      },
    });
    const statementProvenance = {
      _type: 'https://in-toto.io/Statement/v1',
      subject: [{ name: 'guard-verification.intoto.json', digest: { sha256: statementDigest } }],
      predicateType: 'https://slsa.dev/provenance/v1',
      predicate: {},
    };
    const files = {
      'guard-statement.json': statementText,
      'guard-bundle.json': JSON.stringify(makeBundle(statement)),
      'statement-bundle.json': JSON.stringify(makeBundle(statementProvenance)),
    };

    const output = runEmbeddedScript(
      embeddedScript('attest', 'Expected a Sigstore bundle containing a DSSE in-toto envelope'),
      files,
      {
        GUARD_BUNDLE_PATH: 'guard-bundle.json',
        STATEMENT_BUNDLE_PATH: 'statement-bundle.json',
        STATEMENT_PATH: 'guard-statement.json',
        OUTPUT_PATH: 'guard-verification.intoto.jsonl',
        BUNDLE_OUTPUT_PATH: 'guard-verification.sigstore.jsonl',
      },
    );
    const lines = output['guard-verification.intoto.jsonl'].trim().split('\n');
    const bundleLines = output['guard-verification.sigstore.jsonl'].trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(bundleLines).toHaveLength(2);
    expect(bundleLines.map((line) => JSON.parse(line))).toEqual([
      makeBundle(statement),
      makeBundle(statementProvenance),
    ]);
    expect(
      JSON.parse(Buffer.from(JSON.parse(lines[0]).payload, 'base64').toString('utf8')),
    ).toEqual(statement);
    expect(
      JSON.parse(Buffer.from(JSON.parse(lines[1]).payload, 'base64').toString('utf8')),
    ).toEqual(statementProvenance);
  });

  it('pins every external action to a full commit SHA', () => {
    const uses = Object.values(workflow.jobs ?? {}).flatMap((job) =>
      (job.steps ?? []).map((step) => step.uses).filter((value): value is string => Boolean(value)),
    );
    for (const action of uses) expect(action).toMatch(/@[a-f0-9]{40}\b/i);
  });
});
