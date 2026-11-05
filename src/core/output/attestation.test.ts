import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { GuardVerificationReceipt } from '../history/runs.js';
import { computeVerificationScopeFingerprint } from '../verification/scope.js';
import { guardReceiptToInToto, GUARD_VERIFICATION_PREDICATE_TYPE } from './attestation.js';

const guardVersion = (
  JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

function receipt(
  outcome: GuardVerificationReceipt['outcome'] = 'pass',
  scope: Partial<NonNullable<GuardVerificationReceipt['verificationScope']>> = {},
): GuardVerificationReceipt {
  const verificationScope = {
    algorithm: 'sha256' as const,
    fingerprint: '',
    complete: true,
    stable: true,
    source: {
      repository: 'codapult/example',
      commit: '1'.repeat(40),
      headSha: '1'.repeat(40),
      baseSha: '2'.repeat(40),
      baseCommit: '2'.repeat(40),
    },
    files: [
      { path: 'src/current.ts', status: 'present' as const, sha256: 'b'.repeat(64) },
      { path: 'src/removed.ts', status: 'deleted' as const },
    ],
    ...scope,
  };
  const policy = { fingerprint: 'd'.repeat(64), source: 'working-tree' as const };
  const tool = { name: '@codapult/guard', version: guardVersion };
  if (scope.fingerprint === undefined) {
    verificationScope.fingerprint = computeVerificationScopeFingerprint({
      policyFingerprint: policy.fingerprint,
      tool,
      files: verificationScope.files,
      source: verificationScope.source,
    });
  }
  return {
    version: 1,
    kind: 'verification-receipt',
    runId: 'run-1',
    generatedAt: '2026-10-31T00:00:00.000Z',
    outcome,
    gate: 'none',
    subject: {
      repository: 'codapult/example',
      commit: '1'.repeat(40),
      headSha: '1'.repeat(40),
      baseSha: '2'.repeat(40),
      baseCommit: '2'.repeat(40),
      changedFiles: [],
      workingTreeDirty: false,
    },
    policy,
    verificationScope,
    stages: { 'verification-scope': 'ok' },
    checks: {},
    findings: {
      total: 0,
      errors: 0,
      warnings: 0,
      waived: 0,
      waiverWarnings: 0,
      expiredWaivers: 0,
      fingerprints: [],
      ruleIds: [],
    },
    contractIssues: [],
    decisionIds: [],
    tool,
  };
}

describe('Guard in-toto attestation', () => {
  it('binds the receipt to its verification context and present file subjects', () => {
    const verificationReceipt = receipt();

    expect(guardReceiptToInToto(verificationReceipt)).toEqual({
      _type: 'https://in-toto.io/Statement/v1',
      subject: [
        {
          name: 'codapult-guard:verification-context',
          digest: { sha256: verificationReceipt.verificationScope?.fingerprint },
        },
        { name: 'file:src/current.ts', digest: { sha256: 'b'.repeat(64) } },
      ],
      predicateType: GUARD_VERIFICATION_PREDICATE_TYPE,
      predicate: { receipt: verificationReceipt },
    });
  });

  it.each([
    ['a failed result', receipt('fail')],
    ['an incomplete scope', receipt('pass', { complete: false })],
    ['a changing scope', receipt('pass', { stable: false })],
    ['a malformed scope digest', receipt('pass', { fingerprint: 'not-a-digest' })],
    [
      'a scope containing an unavailable file',
      receipt('pass', {
        files: [{ path: 'src/unavailable.ts', status: 'unavailable' }],
      }),
    ],
    [
      'a scope containing a non-normalized path',
      receipt('pass', {
        files: [{ path: 'src\\file.ts', status: 'present', sha256: 'e'.repeat(64) }],
      }),
    ],
    [
      'a deleted path with a previous-content digest',
      receipt('pass', {
        files: [{ path: 'src/removed.ts', status: 'deleted', sha256: 'e'.repeat(64) }],
      }),
    ],
  ])('rejects %s', (_description, verificationReceipt) => {
    expect(() => guardReceiptToInToto(verificationReceipt)).toThrow(
      'Only a passing receipt with a complete, stable verification scope can be attested.',
    );
  });

  it('keeps every present file subject even when the list exceeds common signing limits', () => {
    const manyFiles = Array.from({ length: 1_024 }, (_, index) => ({
      path: `src/${index.toString().padStart(4, '0')}.ts`,
      status: 'present' as const,
      sha256: 'e'.repeat(64),
    }));
    const verificationReceipt = receipt('pass', { files: manyFiles });
    verificationReceipt.verificationScope!.fingerprint = computeVerificationScopeFingerprint({
      policyFingerprint: verificationReceipt.policy!.fingerprint,
      tool: verificationReceipt.tool,
      files: manyFiles,
      source: verificationReceipt.verificationScope!.source,
    });

    expect(guardReceiptToInToto(verificationReceipt).subject).toHaveLength(1_025);
  });
});
