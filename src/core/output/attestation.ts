import type { GuardVerificationReceipt } from '../history/runs.js';

export const GUARD_VERIFICATION_PREDICATE_TYPE =
  'https://codapult.dev/attestations/guard-verification/v1';

export interface GuardVerificationInTotoStatement {
  _type: 'https://in-toto.io/Statement/v1';
  subject: {
    name: 'codapult-guard:verification-context';
    digest: { sha256: string };
  }[];
  predicateType: typeof GUARD_VERIFICATION_PREDICATE_TYPE;
  predicate: { receipt: GuardVerificationReceipt };
}

/** Bind a successful Guard receipt to the exact policy and file scope it verified. */
export function guardReceiptToInToto(
  receipt: GuardVerificationReceipt,
): GuardVerificationInTotoStatement {
  const scope = receipt.verificationScope;
  if (
    receipt.outcome !== 'pass' ||
    !scope?.complete ||
    !scope.stable ||
    !/^[a-f0-9]{64}$/.test(scope.fingerprint)
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
    ],
    predicateType: GUARD_VERIFICATION_PREDICATE_TYPE,
    predicate: { receipt },
  };
}
