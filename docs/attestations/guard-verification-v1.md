# Guard verification predicate v1

This document specifies the Guard verification predicate identified by:

```text
https://github.com/codapult/codapult-guard/blob/main/docs/attestations/guard-verification-v1.md
```

The identifier is versioned independently from both the in-toto Statement version and the
embedded Guard receipt version. Consumers must reject predicate types and receipt versions they
do not support.

## Meaning

Guard emits an in-toto Statement v1 only for a verification whose receipt has `outcome: "pass"`
and whose `verificationScope` is complete and stable. The statement makes this bounded claim:

> The named Guard version reported a passing verification for the policy and file inventory
> represented by this verification-context fingerprint, with the recorded invocation and results.

This is a claim made by the producer. The statement alone does not authenticate the producer or
execution environment. The exported file is unsigned; signing and verifying its provenance are
separate steps.

## Subject and predicate

The in-toto `subject` contains exactly one synthetic aggregate object:

```json
{
  "name": "codapult-guard:verification-context",
  "digest": { "sha256": "<verificationScope.fingerprint>" }
}
```

This is not a Git commit digest and is not a list of source files. It identifies Guard's
verification context: the effective policy fingerprint, Guard name and version, and the sorted
file inventory with each path, status, and available file digest. The fingerprint is an opaque
SHA-256 binding produced by Guard. Consumers must require it to equal
`predicate.receipt.verificationScope.fingerprint`; they should not attempt to reconstruct its
preimage from receipt fields.

The `predicate` contains `{ "receipt": <GuardVerificationReceipt> }`. The receipt describes the
verification: policy, scope inventory, stages, checks, findings, invocation, and available Git or
hosting-event context. Per-file SHA-256 digests are in
`receipt.verificationScope.files[*].sha256`, not in the in-toto subject. No source contents are
included.

## Example

Values below are illustrative. The fingerprint values are placeholders and are not a mutually
verifiable example.

```json
{
  "_type": "https://in-toto.io/Statement/v1",
  "subject": [
    {
      "name": "codapult-guard:verification-context",
      "digest": {
        "sha256": "<same-as-receipt-verificationScope-fingerprint>"
      }
    }
  ],
  "predicateType": "https://github.com/codapult/codapult-guard/blob/main/docs/attestations/guard-verification-v1.md",
  "predicate": {
    "receipt": {
      "version": 1,
      "kind": "verification-receipt",
      "runId": "<unique-run-id>",
      "generatedAt": "2026-10-31T12:00:00.000Z",
      "outcome": "pass",
      "gate": "none",
      "subject": {
        "commit": "<full-git-commit-sha>",
        "baseRef": "main",
        "baseCommit": "<full-base-commit-sha>",
        "headSha": "<pull-request-head-sha>",
        "baseSha": "<pull-request-base-sha>",
        "changedFiles": ["src/example.ts"],
        "workingTreeDirty": false
      },
      "policy": {
        "fingerprint": "<effective-policy-fingerprint>",
        "source": "git-ref",
        "ref": "main"
      },
      "verificationScope": {
        "algorithm": "sha256",
        "fingerprint": "<same-as-subject-digest>",
        "complete": true,
        "stable": true,
        "files": [
          {
            "path": "src/example.ts",
            "status": "present",
            "sha256": "<file-content-sha256>"
          },
          {
            "path": "src/removed.ts",
            "status": "deleted",
            "sha256": "<base-file-content-sha256>"
          }
        ]
      },
      "requiredStages": ["architecture-policy", "policy-surface", "verification-scope"],
      "incompleteStages": [],
      "stages": {
        "architecture-policy": "ok",
        "policy-surface": "ok",
        "verification-scope": "ok"
      },
      "checks": {},
      "findings": {
        "total": 0,
        "errors": 0,
        "warnings": 0,
        "waived": 0,
        "waiverWarnings": 0,
        "expiredWaivers": 0,
        "fingerprints": [],
        "ruleIds": []
      },
      "contractIssues": [],
      "decisionIds": [],
      "tool": {
        "name": "@codapult/guard",
        "version": "<guard-version>"
      }
    }
  }
}
```

Optional receipt fields are omitted when unavailable or not applicable. Additional fields within a
supported receipt version may be added compatibly; consumers should ignore unknown fields while
validating all fields they rely on.

## Consumer validation

A consumer relying on this predicate should at minimum:

1. Require `_type` to equal `https://in-toto.io/Statement/v1` and `predicateType` to equal this
   specification's identifier.
2. Require exactly one subject named `codapult-guard:verification-context` with a lowercase,
   64-character SHA-256 digest.
3. Require a receipt with `version: 1`, `kind: "verification-receipt"`, and `outcome: "pass"`.
4. Require `verificationScope.algorithm: "sha256"`, `complete: true`, `stable: true`, and a
   fingerprint equal to the subject digest.
5. Apply its own policy to `requiredStages`, `stages`, policy identity, Guard version, Git context,
   and checks. `pass` means Guard's effective configured gate passed; it does not mean every
   possible test, scanner, or project check ran.
6. Verify the statement's signature/provenance separately if producer identity or execution
   environment matters.

An incomplete or unstable verification cannot be exported as this predicate. Absence of a
statement is not itself a machine-readable `incomplete` result; consumers that need failure details
must also retain and inspect Guard's JSON command output.

## Scope and limits

The receipt provides paths and hashes, not file contents. It does not prove that the discovered
inventory matches a consumer's expected inventory, that a GitHub event is authentic, or that the
workflow executing Guard is trusted. Consumers should independently bind the receipt to expected
revisions and require a trusted workflow/signature where those properties are needed.
