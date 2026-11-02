# GitHub setup presets

Choose a preset based on the protection you need. Each combines a Guard workflow template with the
GitHub settings that make the check useful for that level of trust.

| Preset | Good fit | Template |
| --- | --- | --- |
| [PR checks](#github-pr-checks) | Add architecture feedback and a required check to pull requests. | `guard-ci.yml` |
| [Trusted PR verification](#trusted-pr-verification) | Keep the verifier under protected control and validate fork PRs. | `guard-trusted-pr-attestation.yml` |
| [Merge queue](#merge-queue) | Verify the exact aggregate candidate built by a GitHub merge queue. | `guard-trusted-merge-group.yml` |

For local development and AI-agent instructions, see [Get started](../README.md#get-started) and
the [agent integration guide](guard-agent-integration.md).

## GitHub PR checks

Use this preset to add Guard feedback to normal pull requests. Copy the workflow from the installed
package:

```bash
cp node_modules/@codapult/guard/docs/guard-ci.yml .github/workflows/guard.yml
```

Require the **Architecture Guard** check in branch protection or a repository ruleset. The template
uses `host-review` by default: it verifies source changes against policy from the base branch and
reports policy-sensitive changes for owner review. Configure required code-owner review for Guard
policy and workflow files if those changes need separate approval.

This workflow is stored in the repository it checks, so a pull request can change the workflow
definition. Treat it as useful verification and feedback, not as a trusted verifier of its own
integrity. The template avoids running pull-request-owned project scripts; keep tests, builds, and
other required project checks as separate required checks.

The default is suitable when your branch rules and owner-review process govern changes to the Guard
workflow and policy. Set the Actions variable `CODAPULT_GUARD_POLICY_MODE` to `strict` if policy or
protected-path changes should fail the Guard check until handled through a separate owner-controlled
change. See [policy-change modes](guard.md#policy-provenance-in-ci) before changing this setting.

## Trusted PR verification

Choose this preset when a pull request must not be able to replace the workflow that decides
whether it passes. Copy `guard-trusted-pr-attestation.yml` into the target repository and commit it
to the protected default branch. Require the
**Guard trusted verification** check in branch protection or a ruleset. The exact version, commit,
permissions, and setup requirements are in [Install the trusted GitHub Actions workflow](guard.md#install-the-trusted-github-actions-workflow).

The workflow loads policy from the PR base and verifies the exact PR revisions. It checks fork PRs
too, but creates and signs an attestation only for same-repository PRs. It verifies Guard's
architecture and policy checks; it does not run or attest project tests and builds.

### Verify the setup

After protecting the default branch and requiring the trusted check, validate both paths:

1. Open a test PR from a branch in the same repository. Confirm **Guard trusted verification** passes
   and the run contains the `guard-trusted-pr-attestation` artifact. Follow
   [Verify a signed receipt](guard.md#verify-a-signed-receipt) if you also want to validate the
   signature and receipt fields.
2. Open a test PR whose head branch is in a fork of the target repository. Confirm
   **Guard trusted verification** passes and the workflow summary says it checked the exact head and
   base revisions using policy from the base revision. A fork PR must not produce the
   `guard-trusted-pr-attestation` artifact or a signed GitHub artifact attestation.
3. Keep separate project test and build checks required, then close the test PRs after confirming
   the results.

## Merge queue

Add this preset only when the target branch uses GitHub merge queues. A merge queue creates a
`merge_group` candidate that is distinct from each PR's head, so the required check must run against
the exact queue candidate and its base.

For a trusted queue check, use `guard-trusted-merge-group.yml` from a protected workflow repository
and require it through an organization ruleset. Also require the trusted PR check before queue entry,
and make project test/build workflows run on `merge_group`. The full configuration and plan
requirements are in [Require Guard on GitHub merge queues](guard.md#require-guard-on-github-merge-queues).

The ordinary `guard-ci.yml` template also runs on `merge_group`, but it lives in the candidate
repository. Use that option for candidate feedback when its workflow source is protected by your
repository review policy; do not treat it as an independently protected workflow.
