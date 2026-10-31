import { describe, expect, it } from 'vitest';
import type { GuardVerificationReceipt } from '../history/runs.js';
import { guardReceiptToInToto, GUARD_VERIFICATION_PREDICATE_TYPE } from './attestation.js';

function receipt(
  outcome: GuardVerificationReceipt['outcome'] = 'pass',
  scope: Partial<NonNullable<GuardVerificationReceipt['verificationScope']>> = {},
): GuardVerificationReceipt {
  return {
    version: 1,
    kind: 'verification-receipt',
    runId: 'run-1',
    generatedAt: '2026-10-31T00:00:00.000Z',
    outcome,
    gate: 'none',
    subject: { changedFiles: [], workingTreeDirty: false },
    verificationScope: {
      algorithm: 'sha256',
      fingerprint: 'a'.repeat(64),
      complete: true,
      stable: true,
      files: [],
      ...scope,
    },
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
    tool: { name: '@codapult/guard', version: '0.10.0' },
  };
}

describe('Guard in-toto attestation', () => {
  it('binds the receipt to its exact verification-context digest', () => {
    const verificationReceipt = receipt();

    expect(guardReceiptToInToto(verificationReceipt)).toEqual({
      _type: 'https://in-toto.io/Statement/v1',
      subject: [
        {
          name: 'codapult-guard:verification-context',
          digest: { sha256: verificationReceipt.verificationScope?.fingerprint },
        },
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
  ])('rejects %s', (_description, verificationReceipt) => {
    expect(() => guardReceiptToInToto(verificationReceipt)).toThrow(
      'Only a passing receipt with a complete, stable verification scope can be attested.',
    );
  });
});
