import type { GuardVerificationReceipt } from '../history/runs.js';
import { computeVerificationScopeFingerprint } from '../verification/scope.js';

export const GUARD_VERIFICATION_PREDICATE_TYPE =
  'https://github.com/codapult/codapult-guard/blob/main/docs/attestations/guard-verification-v1.md';

export interface GuardVerificationInTotoStatement {
  _type: 'https://in-toto.io/Statement/v1';
  subject: {
    name: string;
    digest: { sha256: string };
  }[];
  predicateType: typeof GUARD_VERIFICATION_PREDICATE_TYPE;
  predicate: { receipt: GuardVerificationReceipt };
}

/** Bind a successful Guard receipt to its aggregate scope and each present file. */
export function guardReceiptToInToto(
  receipt: GuardVerificationReceipt,
): GuardVerificationInTotoStatement {
  const scope = receipt.verificationScope;
  if (
    receipt.outcome !== 'pass' ||
    !scope?.complete ||
    !scope.stable ||
    !scope.source ||
    !/^[a-f0-9]{40}$/.test(scope.source.commit ?? '') ||
    scope.source.repository !== (receipt.subject.repository ?? null) ||
    scope.source.commit !== (receipt.subject.commit ?? null) ||
    scope.source.headSha !== (receipt.subject.headSha ?? null) ||
    scope.source.baseSha !== (receipt.subject.baseSha ?? null) ||
    scope.source.baseCommit !== (receipt.subject.baseCommit ?? null) ||
    !/^[a-f0-9]{64}$/.test(scope.fingerprint) ||
    !receipt.policy?.fingerprint ||
    !Array.isArray(scope.files) ||
    scope.files.some(
      (file) =>
        !file.path ||
        file.path.includes('\\') ||
        file.path.startsWith('/') ||
        /^[a-z]:\//i.test(file.path) ||
        file.path.split('/').includes('..') ||
        !['present', 'deleted'].includes(file.status) ||
        (file.status === 'present'
          ? typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)
          : file.sha256 !== undefined),
    ) ||
    scope.files.some((file, index) => {
      const previous = scope.files[index - 1];
      return previous !== undefined && previous.path >= file.path;
    }) ||
    computeVerificationScopeFingerprint({
      policyFingerprint: receipt.policy.fingerprint,
      tool: receipt.tool,
      files: scope.files,
      source: scope.source,
    }) !== scope.fingerprint
  ) {
    throw new Error(
      'Only a passing receipt with a complete, stable verification scope can be attested.',
    );
  }
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [
      {
        name: 'codapult-guard:verification-context',
        digest: { sha256: scope.fingerprint },
      },
      ...scope.files.flatMap((file) =>
        file.status === 'present' && file.sha256 !== undefined
          ? [{ name: `file:${file.path}`, digest: { sha256: file.sha256 } }]
          : [],
      ),
    ],
    predicateType: GUARD_VERIFICATION_PREDICATE_TYPE,
    predicate: { receipt },
  };
}
