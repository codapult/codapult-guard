# Policy mutation control

Guard reports and validates policy mutations, but it cannot prove that a process invoking the CLI
is a human. A shell-capable coding agent can technically execute the same CLI command as a
developer. Human or independent approval must therefore be enforced by the host or CI system.

Inspect the machine-readable mutation contract:

```bash
codapult-guard policy mutations --json
```

The contract identifies operations that change policy, including:

- `init.force`;
- `rules.approve` and `contracts.approve|reject`;
- `baseline.accept|remove`;
- `waiver.add|renew|remove`;
- direct edits to `.codapult/guard/*`.

Every listed operation has `externalApprovalRequired: true`. This is a declaration for the host;
it is not an identity or signature mechanism.

## Agent shell policy

Use the host's command approval or `PreToolUse` mechanism to reject policy mutations while the
agent session is running. The exact hook format is host-specific, but the denied command set
should include:

```text
codapult-guard init --force
codapult-guard baseline accept
codapult-guard baseline remove
codapult-guard waiver add
codapult-guard waiver renew
codapult-guard waiver remove
codapult-guard rules approve
codapult-guard contracts approve
codapult-guard contracts reject
```

Allow read-only commands such as `context`, `check`, `review`, `verify`, `audit`, `impact`, and
`policy mutations`. If a policy change is needed, the agent may explain or propose it, but the
mutation should be performed through a human-approved branch or protected CI job.

## CI policy

Keep `.codapult/guard/*` under CODEOWNERS and protected-branch review. For pull requests, verify
against the base policy rather than the policy changed in the pull request:

```bash
codapult-guard verify \
  --policy-base "$BASE_SHA" \
  --fail-on-policy-change \
  --json
```

The bundled [`guard-ci.yml`](guard-ci.yml) shows the complete workflow. A policy-changing pull
request should require the configured architecture owner; the Guard result alone does not grant
that approval.

## Adversarial test

The relevant failure scenario is:

```text
agent changes source
  → Guard reports a violation
  → agent attempts waiver/baseline/policy mutation
  → host blocks the mutation
  → agent must repair source or request human review
```

Guard tests the policy checks and emits the mutation contract. The host or CI layer tests whether
the attempted command is actually blocked.
