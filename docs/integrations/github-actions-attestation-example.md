# GitHub Actions: trusted Guard attestation example

This guide shows how to produce a Guard in-toto Statement, sign it in GitHub Actions, and export
DSSE envelopes or full Sigstore Bundles as JSONL. The workflow is reusable across repositories; it
does not depend on a specific application or consumer.

## Set up the workflow

1. Initialize Guard and commit its policy to the default branch. The policy must include a GitHub
   Actions integrity contract for the ordinary PR workflow.
2. Copy the [trusted PR workflow template](../guard-trusted-pr-attestation.yml) to
   `.github/workflows/guard-trusted-pr-attestation.yml` and commit it to the default branch. GitHub
   loads `pull_request_target` workflows from the default branch, so this workflow starts on PRs
   only after it has been merged.
3. Add these repository Actions variables, pinning an exact Guard release and its full commit SHA:

   - `CODAPULT_GUARD_VERSION=<exact-version>`
   - `CODAPULT_GUARD_COMMIT=<40-character-commit-sha-for-that-tag>`

   The workflow checks the version, tag, commit, and package manifest before building Guard.

4. Enable GitHub Actions artifact attestations for the repository. The workflow's signer job needs
   `id-token: write`, `attestations: write`, and `artifact-metadata: write` permissions. The
   verifier job has only `contents: read`.
5. Protect the default branch. Require the `Guard trusted verification` status from GitHub Actions,
   keep project tests as separate required checks, and require owner review for changes to the
   trusted workflow and Guard policy.
6. Open a same-repository PR. The trusted verifier checks its exact head against policy from its
   exact base. Eligible PRs receive a signed attestation only after a passing, complete, stable
   receipt. Fork PRs are verified but do not receive a signed artifact. In `host-review` mode,
   policy-sensitive changes do not receive a signed statement; owner review is enforced separately
   before merge. See the [trusted PR workflow policy](../github-setup-presets.md#trusted-pr-verification).

Requiring `Guard trusted verification` makes the Guard result a merge gate; it does not require a
signed attestation. Signing and artifact upload run separately, and may be skipped for fork PRs or
policy-sensitive changes in `host-review` mode. Consumers that require signed evidence must verify
the attestation under their own policy.

Download a run's signed files with:

```bash
gh run download <run-id> \
  --repo <owner>/<repository> \
  --name guard-trusted-pr-attestation
```

The artifact contains `guard-verification.intoto.jsonl` and
`guard-verification.sigstore.jsonl`. The companion artifact `guard-trusted-pr-statement` contains
the plain JSON Statement that the verifier job validated. The file is unsigned by itself; consumers
must verify its associated signed provenance before trusting it.

## Read the JSONL files

Every non-empty line is one independent entry:

- In `.intoto.jsonl`, each line is a DSSE envelope with an in-toto Statement payload.
- In `.sigstore.jsonl`, each line is the full Sigstore Bundle for the corresponding envelope.

The trusted workflow writes two entries. The first is Guard's signed verification Statement. It
uses the predicate type in the [Guard verification v1 specification](../attestations/guard-verification-v1.md).
The second is SLSA provenance for the exported Statement file; it is not a second Guard verdict.
Select entries by decoded predicate type and verify each signature against the expected workflow
identity and repository before relying on its claims.

The Guard Statement's `subject` contains the aggregate `codapult-guard:verification-context`
subject followed by one `file:<path>` subject for each present file in the scope. The predicate is
`{ "receipt": <GuardVerificationReceipt> }`. The receipt includes the result, policy fingerprint,
verification scope, stage statuses, incomplete stages, invocation, tool version, and available PR
context. Deleted paths remain in the receipt and aggregate scope but have no file subject because
they are not present in the verified tree.

The checked-in [DSSE example](../attestations/examples/github-actions/guard-verification.intoto.jsonl)
and [Sigstore Bundle example](../attestations/examples/github-actions/guard-verification.sigstore.jsonl)
are complete outputs from a successful trusted run. The Guard entry reports `outcome: "pass"`, a
complete and stable scope, and no incomplete required stages. It contains 345 subjects: one
aggregate subject and 344 file subjects. The following SLSA provenance entry describes the exported
Statement file.

These fixtures preserve their real signed payloads. The receipt and certificate therefore contain
the source repository and workflow identity used to create this example. Treat those values as
fixture provenance; consumers must configure and enforce the expected repository and signer for
their own workflow.

For a direct GitHub CLI check of the Guard entry, select its Bundle from the JSONL file by predicate
type, then verify a present file listed in the receipt. This checks the file digest against the
Guard subject and verifies the Bundle's signature and workflow identity:

```bash
PREDICATE_TYPE=https://github.com/codapult/codapult-guard/blob/main/docs/attestations/guard-verification-v1.md
jq -cs --arg predicate "$PREDICATE_TYPE" \
  '[.[] | select((.dsseEnvelope.payload | @base64d | fromjson).predicateType == $predicate)]
   | if length == 1 then .[0] else error("expected exactly one Guard Bundle") end' \
  guard-verification.sigstore.jsonl > guard-verification.bundle.json

gh attestation verify path/to/present-file \
  --repo ORG/REPO \
  --bundle guard-verification.bundle.json \
  --predicate-type "$PREDICATE_TYPE" \
  --signer-workflow ORG/REPO/.github/workflows/guard-trusted-pr-attestation.yml \
  --source-ref refs/heads/main
```

Use the PR's exact head and base SHAs when checking that the receipt applies to the change under
review. The [Guard consumer script](../verify-guard-attestation.mjs) validates the plain Statement's
predicate, receipt, scope fingerprint, subjects, and expected PR revisions after GitHub attestation
verification succeeds. Its input is the plain Statement file, not the JSONL envelope or Bundle.

For repository-wide automation, use a Sigstore-compatible verifier to process every Bundle and
enforce the expected certificate identity and transparency-log verification for the consumer's
trust policy. Then validate the decoded Guard Statement and bind its receipt to the expected
repository, head, and base revisions with the consumer script.
