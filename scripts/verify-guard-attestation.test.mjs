import { describe, expect, it, vi } from 'vitest';
import { validateGuardStatement, verifyWithGitHub } from '../docs/verify-guard-attestation.mjs';

const expectedHead = 'a'.repeat(40);
const expectedBase = 'b'.repeat(40);

function makeStatement(overrides = {}) {
  const receipt = {
    version: 1,
    kind: 'verification-receipt',
    runId: 'run-123',
    outcome: 'pass',
    ...overrides.receipt,
    subject: { headSha: expectedHead, baseSha: expectedBase, ...overrides.receipt?.subject },
    verificationScope: {
      algorithm: 'sha256',
      fingerprint: 'c'.repeat(64),
      complete: true,
      stable: true,
      ...overrides.receipt?.verificationScope,
    },
  };
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
    ...overrides.statement,
  };
}

describe('trusted Guard attestation consumer', () => {
  it('accepts a supported passing receipt bound to the expected PR and scope', () => {
    const statement = makeStatement();

    expect(validateGuardStatement(statement, { expectedHead, expectedBase })).toEqual({
      runId: 'run-123',
      headSha: expectedHead,
      baseSha: expectedBase,
      fingerprint: 'c'.repeat(64),
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
      'does not match the statement subject',
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
