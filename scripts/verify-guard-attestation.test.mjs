import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { validateGuardStatement, verifyWithGitHub } from '../docs/verify-guard-attestation.mjs';

const guardVersion = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

const expectedHead = 'a'.repeat(40);
const expectedBase = 'b'.repeat(40);

function makeStatement(overrides = {}) {
  const receipt = {
    version: 1,
    kind: 'verification-receipt',
    runId: 'run-123',
    outcome: 'pass',
    requiredStages: ['architecture-policy', 'verification-scope'],
    incompleteStages: [],
    stages: { 'architecture-policy': 'ok', 'verification-scope': 'ok' },
    policy: { fingerprint: 'd'.repeat(64) },
    tool: { name: '@codapult/guard', version: guardVersion },
    ...overrides.receipt,
    subject: {
      repository: 'example/project',
      commit: expectedHead,
      headSha: expectedHead,
      baseSha: expectedBase,
      baseCommit: expectedBase,
      ...overrides.receipt?.subject,
    },
    verificationScope: {
      algorithm: 'sha256',
      complete: true,
      stable: true,
      source: {
        repository: 'example/project',
        commit: expectedHead,
        headSha: expectedHead,
        baseSha: expectedBase,
        baseCommit: expectedBase,
      },
      files: [],
      ...overrides.receipt?.verificationScope,
    },
  };
  if (overrides.receipt?.verificationScope?.fingerprint === undefined) {
    receipt.verificationScope.fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          algorithm: 'sha256',
          policyFingerprint: receipt.policy.fingerprint,
          tool: { name: receipt.tool.name, version: receipt.tool.version },
          files: receipt.verificationScope.files.map((file) =>
            file.status === 'present'
              ? { path: file.path, status: file.status, sha256: file.sha256 }
              : { path: file.path, status: file.status },
          ),
          source: {
            repository: receipt.verificationScope.source.repository,
            commit: receipt.verificationScope.source.commit,
            headSha: receipt.verificationScope.source.headSha,
            baseSha: receipt.verificationScope.source.baseSha,
            baseCommit: receipt.verificationScope.source.baseCommit,
          },
        }),
      )
      .digest('hex');
  }
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [
      {
        name: 'codapult-guard:verification-context',
        digest: { sha256: receipt.verificationScope.fingerprint },
      },
      ...receipt.verificationScope.files
        .filter((file) => file.status === 'present')
        .map((file) => ({ name: `file:${file.path}`, digest: { sha256: file.sha256 } })),
    ],
    predicateType:
      'https://github.com/codapult/codapult-guard/blob/main/docs/attestations/guard-verification-v1.md',
    predicate: { receipt },
    ...overrides.statement,
  };
}

describe('trusted Guard attestation consumer', () => {
  it('accepts a supported passing receipt bound to the expected PR and scope', () => {
    const statement = makeStatement();

    expect(
      validateGuardStatement(statement, {
        expectedHead,
        expectedBase,
        expectedRepository: 'EXAMPLE/PROJECT',
      }),
    ).toEqual({
      runId: 'run-123',
      headSha: expectedHead,
      baseSha: expectedBase,
      fingerprint: statement.predicate.receipt.verificationScope.fingerprint,
    });
  });

  it.each([
    [
      'unsupported receipt schema',
      { receipt: { version: 2 } },
      'Unsupported Guard verification receipt schema',
    ],
    ['failed verdict', { receipt: { outcome: 'fail' } }, 'not a successful verification run'],
    [
      'incomplete required stage',
      { receipt: { stages: { 'architecture-policy': 'skipped' } } },
      'incomplete required verification stages',
    ],
    [
      'incomplete stage list',
      { receipt: { incompleteStages: ['architecture-policy'] } },
      'incomplete required verification stages',
    ],
    [
      'empty required stage list',
      { receipt: { requiredStages: [], stages: {} } },
      'incomplete required verification stages',
    ],
    [
      'required stage list without scope',
      { receipt: { requiredStages: ['architecture-policy'] } },
      'incomplete required verification stages',
    ],
    [
      'unsupported required stage',
      {
        receipt: {
          requiredStages: ['verification-scope', 'future-stage'],
          stages: { 'future-stage': 'ok' },
        },
      },
      'incomplete required verification stages',
    ],
    [
      'malformed policy fingerprint',
      { receipt: { policy: { fingerprint: 'not-a-sha256' } } },
      'unsupported fingerprint inputs',
    ],
    [
      'unexpected tool name',
      { receipt: { tool: { name: 'other-tool' } } },
      'unsupported fingerprint inputs',
    ],
    [
      'non-normalized scope path',
      {
        receipt: {
          verificationScope: {
            files: [{ path: 'src\\file.ts', status: 'present', sha256: 'c'.repeat(64) }],
          },
        },
      },
      'invalid file digest or status',
    ],
    [
      'parent traversal scope path',
      {
        receipt: {
          verificationScope: {
            files: [{ path: '../outside.ts', status: 'present', sha256: 'c'.repeat(64) }],
          },
        },
      },
      'invalid file digest or status',
    ],
    [
      'incomplete scope',
      { receipt: { verificationScope: { complete: false } } },
      'incomplete, unstable',
    ],
    [
      'unstable scope',
      { receipt: { verificationScope: { stable: false } } },
      'incomplete, unstable',
    ],
    [
      'different PR head',
      { receipt: { subject: { headSha: 'd'.repeat(40) } } },
      'does not match the expected',
    ],
    [
      'different PR base',
      { receipt: { subject: { baseSha: 'e'.repeat(40) } } },
      'does not match the expected',
    ],
    [
      'unsupported statement schema',
      { statement: { _type: 'https://in-toto.io/Statement/v0.1' } },
      'Unsupported in-toto statement type',
    ],
    [
      'different scope digest',
      {
        statement: {
          subject: [
            { name: 'codapult-guard:verification-context', digest: { sha256: 'f'.repeat(64) } },
          ],
        },
      },
      'subjects do not match',
    ],
  ])('rejects %s', (_description, overrides, message) => {
    expect(() =>
      validateGuardStatement(makeStatement(overrides), { expectedHead, expectedBase }),
    ).toThrow(message);
  });

  it('requires full expected commit SHAs', () => {
    expect(() =>
      validateGuardStatement(makeStatement(), { expectedHead: 'short', expectedBase }),
    ).toThrow('full 40-character commit SHAs');
  });

  it('validates each present file subject and recomputes the aggregate scope digest', () => {
    const statement = makeStatement({
      receipt: {
        verificationScope: {
          files: [{ path: 'src/app.ts', status: 'present', sha256: 'e'.repeat(64) }],
        },
      },
    });

    expect(validateGuardStatement(statement, { expectedHead, expectedBase }).fingerprint).toBe(
      statement.predicate.receipt.verificationScope.fingerprint,
    );
    statement.subject[1].digest.sha256 = 'f'.repeat(64);
    expect(() => validateGuardStatement(statement, { expectedHead, expectedBase })).toThrow(
      'subjects do not match',
    );
  });

  it('accepts deleted paths as scope facts without digests or individual subjects', () => {
    const statement = makeStatement({
      receipt: {
        verificationScope: {
          files: [{ path: 'src/removed.ts', status: 'deleted' }],
        },
      },
    });

    expect(statement.subject).toHaveLength(1);
    expect(validateGuardStatement(statement, { expectedHead, expectedBase }).fingerprint).toBe(
      statement.predicate.receipt.verificationScope.fingerprint,
    );
  });

  it('asks GitHub CLI to verify the artifact, repository, workflow identity, and source ref', () => {
    const run = vi.fn(() => ({ status: 0, stdout: '[]', stderr: '' }));

    verifyWithGitHub(
      'guard-verification.intoto.json',
      {
        repo: 'example/project',
        signerWorkflow: 'example/project/.github/workflows/guard.yml',
        sourceRef: 'refs/heads/main',
      },
      run,
    );

    expect(run).toHaveBeenCalledWith(
      'gh',
      [
        'attestation',
        'verify',
        'guard-verification.intoto.json',
        '--repo',
        'example/project',
        '--signer-workflow',
        'example/project/.github/workflows/guard.yml',
        '--source-ref',
        'refs/heads/main',
        '--format=json',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  });

  it('fails closed when GitHub CLI cannot verify the signature or signer', () => {
    expect(() =>
      verifyWithGitHub(
        'guard-verification.intoto.json',
        {
          repo: 'example/project',
          signerWorkflow: 'example/project/.github/workflows/guard.yml',
          sourceRef: 'refs/heads/main',
        },
        () => ({ status: 1, stdout: '', stderr: 'signer identity mismatch' }),
      ),
    ).toThrow('GitHub attestation verification failed: signer identity mismatch');
  });
});
