# Guard verification predicate v1

This document specifies the Guard verification predicate identified by:

```text
https://github.com/codapult/codapult-guard/blob/main/docs/attestations/guard-verification-v1.md
```

The identifier is versioned independently from both the in-toto Statement version and the
embedded Guard receipt version. Consumers must reject predicate types and receipt versions they
do not support.

Once v1 is released, this predicate type identifies an immutable contract: its meaning and the
interpretation of existing fields must not change. Compatible clarifications and optional fields
may be added without changing v1 semantics. A breaking change requires a new predicate type version
and specification identifier. Keep this rule in the specification and apply it during release
review; implementation package versions do not version the predicate contract.

## Meaning

Guard emits an in-toto Statement v1 only for a verification whose receipt has `outcome: "pass"`
and whose `verificationScope` is complete and stable. The statement makes this bounded claim:

> The named Guard version reported a passing verification for the policy and file inventory
> represented by this verification-context fingerprint, with the recorded invocation and results.

This is a claim made by the producer. The statement alone does not authenticate the producer or
execution environment. The exported file is unsigned; signing and verifying its provenance are
separate steps.

## Subject and predicate

The in-toto `subject` contains a synthetic aggregate object first, followed by one subject for
each present file in the scope:

```json
{
  "name": "codapult-guard:verification-context",
  "digest": { "sha256": "<verificationScope.fingerprint>" }
}
```

Each present file subject is named `file:<repository-relative-path>` and carries that file's
SHA-256 digest. The aggregate subject identifies the complete verification context; file subjects
make the individual present artifacts addressable to generic in-toto consumers. Both kinds are
covered by the same predicate and signature. A file subject does not mean Guard ran a separate
verification for that file: the claim remains the run-level claim above, evaluated against the
recorded scope and policy.

Deleted files are represented in the receipt and aggregate context, but are not subjects because
they are absent from the verified working tree. Consumers must require exactly the aggregate
subject followed by one `file:<path>` subject per present file, in receipt path order, and match
each file subject to its receipt entry. The v1 predicate does not impose a subject count limit;
signing systems may have their own limits. The supplied GitHub workflow, for example, rejects
statements with more than 1,024 subjects or predicates larger than 16 MiB because of its signing
platform's limits.

The aggregate context digest identifies the effective policy fingerprint, Guard name and version,
sorted inventory (including deleted paths), and a `source` binding. The binding records repository,
checked-out commit, and any available event head, base, and resolved base commit. These values are
also present in the receipt; consumers should compare them with the repository and revisions they
expect. The commit binding distinguishes identical file inventories checked out at different commits.
Its fingerprint is independently reproducible. Guard hashes UTF-8 bytes of compact JSON with these
property orders and no whitespace:

```json
{
  "algorithm": "sha256",
  "policyFingerprint": "<receipt.policy.fingerprint>",
  "tool": { "name": "<receipt.tool.name>", "version": "<receipt.tool.version>" },
  "files": [{ "path": "<path>", "status": "present", "sha256": "<lowercase-hex>" }],
  "source": {
    "repository": "<repository-or-null>",
    "commit": "<commit-or-null>",
    "headSha": "<head-or-null>",
    "baseSha": "<base-or-null>",
    "baseCommit": "<base-commit-or-null>"
  }
}
```

Guard normalizes `\\` in paths to `/`, removes duplicate normalized paths, and sorts paths using
JavaScript's default ascending string order (UTF-16 code units). It does not apply case folding or
Unicode normalization. A complete scope contains non-empty repository-relative paths: absolute
paths, drive-prefixed paths, and paths containing a `..` segment make the scope incomplete. The
fingerprint input uses those normalized, sorted paths and exact file statuses. File objects are
projected onto the v1 fields only: property order `path`, `status`, `sha256`; `sha256` appears only
for `present` files. Unknown file-entry fields are ignored by the fingerprint. A deleted entry is
emitted only when Git confirms the tracked path is deleted and the working-tree lookup confirms it
is absent; otherwise a missing path is `unavailable` and makes the scope incomplete. Deleted entries
do not identify or make a claim about previous bytes. The outer object uses property order
`algorithm`, `policyFingerprint`, `tool`, `files`, `source`; `tool` uses `name`, then `version`, and
`source` uses `repository`, `commit`, `headSha`, `baseSha`, `baseCommit`. Source values unavailable
to the run are JSON `null`. Unknown fields in `source` are ignored. Serialization is compact
`JSON.stringify` output with no added whitespace, encoded as UTF-8 before SHA-256. Consumers must
preserve file array order, project entries onto these fields, and require the digest to equal both
the aggregate subject digest and `predicate.receipt.verificationScope.fingerprint`.

Guard computes the scope before verification and again after verification. `stable: true` means both
observed scopes were complete and had identical fingerprints. This detects changes that remain at
the end of the run; it cannot rule out a transient change that is reverted between observations or
prove that every individual check read the same filesystem snapshot. Consumers that require that
stronger property must run Guard against an immutable snapshot or isolated checkout.

An `unavailable` entry has no `sha256` and makes the scope incomplete. It can occur in a regular
Guard receipt and contributes to that receipt's fingerprint, but it cannot occur in a v1 passing
attestation: such a statement requires `complete: true` and contains only `present` and `deleted`
entries. Guard records a path as deleted only when the working-tree lookup reports that the path is
missing and Git identifies the path as deleted; permission, I/O, unconfirmed missing paths, and
other lookup errors make it unavailable. Deleted paths describe the verified change scope, not
content that is no longer in the working tree. `source.commit` binds the aggregate context to the
checked-out commit; trusted PR consumers should additionally compare repository, head, base, and
base commit against their triggering event.

### Fingerprint test vector

For this input, serialize the object exactly as shown on one line (without the code fence newline):

```json
{
  "algorithm": "sha256",
  "policyFingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "tool": { "name": "@codapult/guard", "version": "1.2.3" },
  "files": [
    {
      "path": "src/deleted.ts",
      "status": "deleted"
    },
    {
      "path": "src/main.ts",
      "status": "present",
      "sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    }
  ],
  "source": {
    "repository": "example/project",
    "commit": "1111111111111111111111111111111111111111",
    "headSha": null,
    "baseSha": null,
    "baseCommit": null
  }
}
```

The SHA-256 digest of those UTF-8 bytes is:

```text
cfce79d9ad299eb4f24139bcaaac30a606a7bb672d3a026e14722bf11ce0fced
```

The `predicate` contains `{ "receipt": <GuardVerificationReceipt> }`. The receipt describes the
verification: policy, scope inventory, stages, checks, findings, invocation, and available Git or
hosting-event context. Per-file SHA-256 digests for present files appear both in
`receipt.verificationScope.files[*].sha256` and as file subjects. Deleted paths have no file subject
or content digest. No source contents are included.
`receipt.tool.version` is the version of the Guard package that produced the receipt; it is distinct
from both the receipt schema version and the predicate type version.

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
    },
    {
      "name": "file:src/example.ts",
      "digest": {
        "sha256": "<same-as-file-entry-sha256>"
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
        "repository": "<repository-or-null>",
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
        "source": {
          "repository": "<repository-or-null>",
          "commit": "<checked-out-commit-or-null>",
          "headSha": "<event-head-or-null>",
          "baseSha": "<event-base-or-null>",
          "baseCommit": "<resolved-base-commit-or-null>"
        },
        "files": [
          {
            "path": "src/example.ts",
            "status": "present",
            "sha256": "<same-as-file-subject-digest>"
          },
          {
            "path": "src/removed.ts",
            "status": "deleted"
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

Optional receipt fields are omitted when unavailable or not applicable. In particular,
`subject.workingTreeDirty` is omitted when Git status cannot be determined; consumers must not treat
an omitted value as `false`. Additional fields within a supported receipt version may be added
compatibly; consumers should ignore unknown fields while validating all fields they rely on.

## Consumer validation

A consumer relying on this predicate should at minimum:

1. Require `_type` to equal `https://in-toto.io/Statement/v1` and `predicateType` to equal this
   specification's identifier.
2. Require the aggregate context subject first, then exactly one `file:<path>` subject per present
   scope entry, with lowercase, 64-character SHA-256 digests matching the receipt.
3. Require a receipt with `version: 1`, `kind: "verification-receipt"`, and `outcome: "pass"`.
4. Require `verificationScope.algorithm: "sha256"`, `complete: true`, `stable: true`, no
   `unavailable` files, require `sha256` on `present` entries and its absence on `deleted` entries,
   recompute its fingerprint as specified above, and match it to the aggregate context subject
   digest.
5. Require `requiredStages` to be a non-empty array containing `verification-scope`, require every
   named stage to be a supported v1 stage with status `ok` in `stages`, and require
   `incompleteStages` to be empty. `requiredStages` is the effective set for this invocation and
   policy; an omitted optional project check or adapter may have status `skipped` without preventing
   `pass`.
6. Apply its own policy to policy identity, Guard version, Git context, and checks. `pass` means
   Guard's effective configured gate passed; it does not mean every possible test, scanner, or
   project check ran. Compare `verificationScope.source` with the repository and revisions expected
   by the consumer; the embedded values are producer claims until authenticated by signature. The
   supplied verifier uses `--repo`, `--expected-head`, and `--expected-base` for these comparisons.
7. Verify the statement's signature/provenance separately if producer identity or execution
   environment matters.

An incomplete or unstable verification cannot be exported as this predicate. Absence of a
statement is not itself a machine-readable `incomplete` result; consumers that need failure details
must also retain and inspect Guard's JSON command output.

## Scope and limits

The receipt provides paths and hashes, not file contents. It does not prove that the discovered
inventory matches a consumer's expected inventory, that a GitHub event is authentic, or that the
workflow executing Guard is trusted. Consumers should independently bind the receipt to expected
revisions and require a trusted workflow/signature where those properties are needed.
