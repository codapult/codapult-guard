# Codapult Guard: Architecture Guardrails for AI Coding Agents

Codapult Guard is local-first architecture guardrail software for AI coding agents and JavaScript
or TypeScript repositories. It detects architectural drift by observing the existing software
architecture, recording project memory, and checking code changes against team-approved rules and
contracts. It also provides bounded project context for AI code review and deterministic checks for
local development and CI.

Guard is not a replacement for ESLint, TypeScript, a test runner, SAST, or a PR review service.
It is universal at the core and especially useful for Next.js SaaS projects, where server/client
boundaries, routes, persistence, authentication, billing, jobs, and AI integrations commonly need
project-specific architectural protection.
It can run a project's existing commands as an optional completion gate, but its own responsibility
is architectural memory, project-specific contracts, regression detection, impact context, and
deterministic evidence.

## Contents

- [The operating model](#the-operating-model)
- [Install and initialize](#install-and-initialize)
- [The generated state](#the-generated-state)
- [The daily workflow](#the-daily-workflow)
- [Policy scope and state changes](#policy-scope-and-state-changes)
- [Command reference](#command-reference)
- [Rules, contracts, and proposals](#rules-contracts-and-proposals)
- [What Guard discovers](#what-guard-discovers)
- [AI-agent and MCP workflow](#ai-agent-and-mcp-workflow)
- [CI and machine-readable output](#ci-and-machine-readable-output)
- [Security and data handling](#security-and-data-handling)
- [Troubleshooting](#troubleshooting)
- [Implementation boundaries](#implementation-boundaries)

## The operating model

Guard separates four concerns:

```text
Facts → Policy → Verification → Decision
 AST     contracts   changed diff   pass / fail
 files   rules       impact paths   warning
 Git     baseline    project tools  needs-review
 graph   conventions adapters       not-configured
```

### Facts

Facts are discovered from the working tree and are not architectural guesses. Depending on the
project, the model includes:

- files, source files, tests, configs, schemas, dependencies, workspaces, and scripts;
- TypeScript/JavaScript AST modules, imports, resolved imports, calls, and dependency graph edges;
- Next.js routes and route methods, React client components, server actions, and API boundaries;
- detected capabilities such as persistence, identity, payments, email, AI, jobs, storage,
  observability, GraphQL/RPC, i18n, deployment, webhooks, cache, analytics, search, and content;
- environment references, Git state, changed files, history snapshots, cycles, layer edges,
  hotspots, boundaries, and impact paths;
- evidence-based patterns and signals. A capability or pattern is reported with evidence and is
  not automatically treated as a mandatory architecture.

### Policy

Policy is the part the project explicitly accepts. It is stored in Guard state and may contain:

- active or proposed rules;
- contracts describing project-specific boundaries and required calls;
- conventions and architecture memory generated from observed evidence;
- a baseline of findings that existed before Guard was enabled.
- optional scoped budgets for explicitly selected risk boundaries;

Guard does not assume that every project must have `UI → actions → services → repositories → DB`.
That shape may be discovered as evidence, proposed for review, and accepted only by a developer.

### Verification and decision

Verification evaluates the current working tree or a diff. It can check Guard policy, configured
project scripts, detected external-tool adapters, runtime compatibility, and contract validity.
The normalized result is one of:

| Outcome          | Meaning                                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| `pass`           | No blocking Guard or configured verification failure.                                                      |
| `fail`           | A blocking finding, invalid contract, failed command, incompatible runtime, or strict missing tool exists. |
| `warning`        | No blocking failure, but warnings were found.                                                              |
| `needs-review`   | Deterministic context is ready for semantic AI review.                                                     |
| `not-configured` | The project has not been initialized or the requested state is unavailable.                                |

Command-specific `status` fields may still exist for compatibility with that command. Consumers
that need one common decision should use `outcome`.

## Install and initialize

Install Guard as a development dependency so local and CI versions are reproducible:

```bash
pnpm add -D @codapult/guard
```

Run commands from the project root. Guard finds the nearest directory containing `.git`,
`package.json`, `tsconfig.json`, or `jsconfig.json`.

Initialize once:

```bash
pnpm exec codapult-guard init
```

Initialization:

1. discovers the current project model;
2. writes project, architecture, convention, proposal, contract, and agent artifacts;
3. generates evidence-based proposed rules and contracts;
4. records current findings in the baseline;
5. adds generated Guard state to the existing formatter ignore file when supported.

Initialization is protected. If a baseline already exists, the command stops instead of silently
changing project memory. Use `--force` only when intentionally replacing the Guard state:

```bash
pnpm exec codapult-guard init --force
```

`--force` is a new baseline decision, not a routine refresh operation. Review and commit the
result deliberately.

## The generated state

Guard stores its project memory under `.codapult/guard/`:

```text
.codapult/
└── guard/
    ├── agent.json
    ├── architecture.json
    ├── baseline.json
    ├── baseline-meta.json
    ├── cache.json
    ├── conventions.json
    ├── contracts.json
    ├── history/
    ├── project.json
    ├── proposals.json
    └── rules.json
```

Guard refuses to create or update state when `.codapult` or `.codapult/guard` is a symbolic link.
This keeps generated state inside the selected project root.

| File                 | Purpose                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `project.json`       | Persisted discovered project model: files, modules, dependencies, routes, capabilities, patterns, Git data, and insights. |
| `architecture.json`  | Human/agent-readable architecture memory derived from observed project facts.                                             |
| `conventions.json`   | Observed conventions and recurring project patterns.                                                                      |
| `rules.json`         | Guard rules, optional scoped budgets, and approval policy. Active items are enforced; proposed items are not.             |
| `contracts.json`     | Project-specific guidance, import boundaries, and required-call contracts.                                                |
| `proposals.json`     | Evidence, confidence, questions, and approval/rejection history for proposed policy.                                      |
| `baseline.json`      | Fingerprints of accepted pre-existing findings. Baseline suppression is fingerprint-based.                                |
| `baseline-meta.json` | Metadata describing the baseline and its project snapshot.                                                                |
| `waivers.json`       | Time-bounded, owner-attributed exceptions for active findings.                                                            |
| `agent.json`         | Host-facing completion-gate and external-tool policy. It does not execute an LLM.                                         |
| `cache.json`         | Optional discovery cache. Unchanged AST modules can be reused by content hash.                                            |
| `history/`           | Project model snapshots, history diffs, and local verification run manifests.                                             |

Discovery is bounded by default to 100,000 files and 25 MiB per file. These limits prevent an
accidental scan of build artifacts or unusually large inputs from exhausting local resources.
Use the public discovery API options `maxFiles` and `maxFileBytes` to raise them deliberately after
configuring the project's ignore boundaries.

Keep the policy and memory files under version control when the team wants shared architecture
guardrails. Treat `cache.json` as disposable implementation cache if the team does not want it
committed. Never commit secrets; Guard excludes common secret files from review input.

## The daily workflow

The normal loop is:

```text
init once → edit → check --changed → review → verify → commit / merge
                         ↘ analyze after structural changes
```

### During a task

Run the fast architecture gate on changed and untracked source files:

```bash
pnpm exec codapult-guard check --changed
```

This compares new findings with the baseline. It does not require the team to repair every old
finding immediately.

### Before completion or merge

Run the unified gate:

```bash
pnpm exec codapult-guard verify
```

By default, `verify` combines Guard checks with the configured completion-gate checks (`lint`,
`typecheck`, `test`, and `build`) and detected external adapters. To run only Guard's own checks:

```bash
pnpm exec codapult-guard verify --no-project-checks
```

Use `--checks lint,typecheck,test` to select project commands for one invocation. Use
`--tools auto|on|off` to control external adapters. `auto` is the default and only runs adapters
whose matching project scripts exist; `on` also reports missing adapters; `off` skips them.

### When the project structure changes

Refresh persisted project memory without changing the baseline:

```bash
pnpm exec codapult-guard analyze
```

Use this after adding a package, moving modules, changing routes/configuration, changing a
workspace, or introducing a new capability. Do not run `init` after every edit. `check`, `review`,
`verify`, and refreshed MCP context discover the current working tree themselves.

### Periodic maintenance

See all current findings, including baseline-suppressed findings:

```bash
pnpm exec codapult-guard audit
```

Inspect Guard state and missing artifacts:

```bash
pnpm exec codapult-guard doctor
```

## Policy scope and state changes

Guard keeps one project policy, and each policy item can be scoped to the boundary it protects:

| Policy item | Scope controls                                                         |
| ----------- | ---------------------------------------------------------------------- |
| Rule        | `files`, import patterns, and deterministic rule kind                  |
| Contract    | `scope`, `entrypoints`, import/package constraints, and required calls |
| Budget      | `scope`, metric, limit, severity, and written reason                   |
| Baseline    | Exact finding fingerprints accepted as legacy debt                     |
| Waiver      | One active finding fingerprint, owner, reason, and expiry              |

The normal verification path does not change source code or approved policy. The operations below
have explicit state-changing behavior:

| Operation                                     | Reads                             | Writes                                       | Policy effect                                   |
| --------------------------------------------- | --------------------------------- | -------------------------------------------- | ----------------------------------------------- |
| `check`, `audit`, `review`, `impact`          | Project and Guard state           | Output only                                  | None                                            |
| `verify`                                      | Project and Guard state           | Local run manifest; runs configured commands | None                                            |
| `analyze`                                     | Project source and Git state      | Derived facts and snapshot                   | Does not change baseline or policy              |
| `init`                                        | Project source and Git state      | Initial Guard state                          | Creates the initial baseline                    |
| `propose`                                     | Project source and policy         | Optional proposal file                       | Proposals are not active policy                 |
| `rules approve` / `contracts approve\|reject` | Policy and proposal state         | Policy and decision history                  | Activates rules; activates or rejects contracts |
| `baseline accept\|remove`                     | Current findings and baseline     | Baseline and decision history                | Changes legacy-debt suppression                 |
| `waiver add\|renew\|remove`                   | Current findings and waiver state | Waivers and decision history                 | Changes a temporary exception                   |

`check` and MCP `codapult_guard_check` scan the full current project unless changed-only mode is
requested. `check --changed`, `verify --changed`, and MCP `changed_only: true` scope deterministic
findings to changed files; `review` is changed-only by default and also includes impact evidence.
`audit` intentionally ignores baseline suppression so maintenance can see the complete current debt.

Guard fails closed when `rules.json` or `contracts.json` is malformed: `verify` returns a structured
failure and CLI checks do not treat corrupted policy as an uninitialized project. Repair the file
or review the diagnosis before using `init --force`.

CLI and MCP expose the same structured error payload for `GUARD_NOT_CONFIGURED`,
`GUARD_CONFIG_INVALID`, and retryable `GUARD_STATE_BUSY` concurrent-write conflicts.
Malformed `agent.json`, `proposals.json`, and `baseline.json` are also rejected instead of being
silently replaced with defaults or an empty state.

Guard state writes use a root-level transaction lock with atomic rename. The lock records PID,
hostname, command, token, and lease metadata. Writers wait with bounded backoff by default; use
`init --no-wait` or `analyze --no-wait` for an immediate retryable `GUARD_STATE_BUSY` result.
If the recorded PID is no longer alive, the orphaned lock is recovered. Age alone is used only for
malformed legacy locks, so a long-running live process is not interrupted.

Derived facts are committed as one generation bundle under `state/generations/` and selected by an
atomic `state/current.json` pointer. The root-level JSON files remain compatibility mirrors. Policy
writes carry a revision and reject stale writers with `GUARD_STATE_STALE` instead of silently
overwriting a newer policy.

Policy activation also uses a small local transaction journal. If the process stops between writing
the policy and its proposal decision history, the next Guard read repairs both artifacts from the
journal before continuing. The journal is local recovery metadata, not a distributed transaction
system; Git/CI remains the source of truth for collaboration and protected review.

Compare persisted project states:

```bash
pnpm exec codapult-guard history
pnpm exec codapult-guard history-diff <from> <to>
```

## Command reference

All commands return a non-zero exit code when their decision is blocking. Add `--json` where the
command supports it for automation.

| Command                                          | Use                                                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `codapult-guard init [--no-wait]`                | Create Guard state and establish the initial baseline. Refuses an existing baseline.              |
| `codapult-guard init --force [--no-wait]`        | Replace existing Guard state intentionally.                                                       |
| `codapult-guard analyze [--refresh] [--no-wait]` | Refresh persisted discovery, architecture, conventions, and snapshot. Does not alter baseline.    |
| `codapult-guard propose`                         | Generate evidence-based rules/contracts for review. Does not activate them.                       |
| `codapult-guard doctor [--fix-cache]`            | Diagnose state; optionally remove the disposable discovery cache.                                 |
| `codapult-guard history`                         | List persisted project snapshots.                                                                 |
| `codapult-guard runs`                            | List local verification runs and outcome/latency summary.                                         |
| `codapult-guard history-diff <from> <to>`        | Compare files, modules, dependencies, capabilities, graph edges, and cycles.                      |
| `codapult-guard impact <files...>`               | Explain direct/transitive dependencies, dependents, capabilities, and relevant contracts.         |
| `codapult-guard policy explain <id>`             | Explain an active or proposed rule/contract, its evidence, and approval history.                  |
| `codapult-guard check [--changed]`               | Enforce active Guard rules/contracts; `--changed` limits findings to changed and untracked files. |
| `codapult-guard audit`                           | Run a full current Guard scan without baseline suppression and validate policy definitions.       |
| `codapult-guard review`                          | Produce a bounded diff + project-context packet for semantic AI review.                           |
| `codapult-guard review --base origin/main`       | Build the review packet from a PR base ref.                                                       |
| `codapult-guard verify`                          | Run Guard, project checks, adapters, runtime, and contract verification as configured.            |
| `codapult-guard governance [--json] [--strict]`  | Audit declared proposal/approval provenance and links from decisions to verification runs.        |
| `codapult-guard rules approve <ids>`             | Activate selected proposed rules.                                                                 |
| `codapult-guard rules approve --all`             | Activate every proposed rule deliberately.                                                        |
| `codapult-guard contracts approve <ids>`         | Activate selected proposed contracts.                                                             |
| `codapult-guard contracts reject <ids>`          | Record rejection for selected proposed contracts.                                                 |
| `codapult-guard baseline accept\|remove <ids>`   | Add or remove baseline fingerprints; a written reason is required.                                |
| `codapult-guard waiver add\|renew\|remove`       | Manage owner-attributed, time-bounded exceptions to exact finding fingerprints.                   |
| `codapult-guard install-agent <target>`          | Add or update a managed Guard instruction block for an AI host.                                   |

`codapult-guard review` does not call an LLM. It creates input for one. A review packet includes changed
files, typed file changes, a bounded/redacted diff, project model, contracts, deterministic
findings, and review instructions. It also includes directional impact: the changed modules'
dependencies, transitive dependents, affected capabilities, impact paths, relevant contracts,
and graph edges. If the Git base is invalid, the packet contains `diffError` and has a failing
outcome.

`changes` distinguishes `added`, `modified`, `deleted`, and `renamed` paths. Deleted and renamed
paths are still checked against the repository root safely; they are not silently discarded just
because the old file no longer exists.

Manage baseline entries without rebuilding the entire project state:

```bash
pnpm exec codapult-guard baseline list
pnpm exec codapult-guard baseline accept <fingerprint> --reason "Accepted legacy boundary"
pnpm exec codapult-guard baseline remove <fingerprint> --reason "Fixed in the current architecture"
```

Use `--all` only as an explicit decision. `baseline accept --all` accepts all findings from the
current full scan; `baseline remove --all` removes fingerprints represented by the current scan.
Each update preserves a decision record in `baseline-meta.json`. A written `--reason` is required
for every manual baseline add or remove; initialization is the only operation that may create the
initial baseline without a manual reason.

### Fingerprint stability

Finding fingerprints intentionally omit line numbers. Formatting, whitespace changes, and moving a
violation to another line therefore do not recreate the same finding. A fingerprint includes the
rule or contract identity and the affected file/import identity. Renaming or moving a module can
therefore produce a new fingerprint; inspect that result and accept it explicitly when the move is
intentional. Guard does not silently transfer a baseline entry between files.

### Temporary waivers

Use a waiver for a known, temporary exception to an active rule or contract. Do not use it to
replace baseline management or to create a broad path-level exemption. A waiver is tied to one
finding fingerprint and requires an owner, reason, creation time, and expiry time:

```bash
pnpm exec codapult-guard waiver add <fingerprint> \
  --owner platform-team \
  --reason "Migration in progress" \
  --expires 2026-12-28 \
  --issue https://github.com/example/project/issues/123
```

Use `waiver list`, `waiver renew`, and `waiver remove` to manage the lifecycle. The default warning
window is 14 days before expiry. Active waivers suppress only their exact fingerprint and remain
visible in reports. Expired waivers no longer suppress findings. `check`, `audit`, and `verify`
reports, review packets, the `codapult_guard_waivers` MCP tool, and the `codapult://guard/waivers` resource
expose waiver state. Protected policy can require approval outside MCP.

Projects may cap the duration of each newly added or renewed waiver without imposing a global
expiry policy:

```json
{
  "waiverPolicy": {
    "warningDays": 14,
    "maxDays": 90
  }
}
```

`maxDays` limits the requested lifetime from the time of the add or renew operation. It is an
optional governance control; omit it when the project wants explicit, owner-reviewed expiry dates
without a fixed maximum. Boundary violations reported by Guard remain blocking when their finding
severity is `error`; warnings and expiry reminders are advisory.

`codapult-guard doctor` also reports explicitly downgraded client, import, or package boundaries as
warnings. It does not change their configured severity; the project owner decides whether the
boundary should become blocking.

### Scoped budgets

Budgets are optional policy for a specific risk boundary, not a global file-size rule. They support
`lines`, `bytes`, and `imports` and require a non-empty scope, limit, severity, and reason:

```json
{
  "budgets": [
    {
      "id": "service-lines",
      "description": "Services must remain reviewable.",
      "metric": "lines",
      "scope": ["src/services"],
      "limit": 300,
      "severity": "warning",
      "reason": "Keep service changes reviewable by one owner.",
      "status": "active"
    }
  ]
}
```

Use budgets only where size or dependency count is evidence of a concrete project risk. Do not
apply them indiscriminately to generated code, schemas, migrations, localization files, or UI
composition. Explicitly scoped generated files and schemas are supported, but invalid, absolute,
parent-directory, or nonexistent scopes fail the Guard gate. Guard does not automatically invent
budgets during `init`.

## Rules, contracts, and proposals

### Rules

Rules are deterministic checks. The current rule kinds are:

```json
{
  "id": "no-client-db",
  "description": "Client modules must not import the database adapter.",
  "severity": "error",
  "kind": "client-forbidden-import",
  "patterns": ["@/lib/db", "drizzle-orm"],
  "files": ["src/components"],
  "status": "active",
  "confidence": "high",
  "evidence": ["src/components/ExistingClient.tsx"]
}
```

Use an existing specialist tool for generic syntax/style/type rules. Guard rules should express
project-specific boundaries and architectural invariants, not duplicate ESLint or TypeScript.

### Contracts

Contracts express intent and boundaries that are meaningful in this project. Supported contract
kinds are:

- `guidance`: a statement, optional guidance, and references for an AI reviewer;
- `import-boundary`: modules must or must not import specified patterns;
- `required-call`: an entrypoint must call one of the specified functions or patterns.

Example:

```json
{
  "id": "server-actions-use-auth",
  "statement": "Every billing server action authenticates the active organization.",
  "kind": "required-call",
  "severity": "error",
  "scope": ["src/lib/actions/billing"],
  "mustCall": ["requireOrganizationMember"],
  "references": ["src/lib/auth/require-organization-member.ts"],
  "status": "active",
  "confidence": "high"
}
```

Package boundaries use workspace package names discovered from manifests. They are useful in
monorepos where a relative path rule would be too fragile:

```json
{
  "id": "apps-cannot-import-db-package",
  "statement": "Application packages must not import the database package directly.",
  "kind": "package-boundary",
  "severity": "error",
  "fromPackages": ["@acme/web", "@acme/admin"],
  "mustNotImportPackages": ["@acme/db"],
  "status": "active",
  "confidence": "high"
}
```

`verify` also returns an impact analysis: changed modules, direct dependencies, transitive
dependents, affected capabilities, and relevant contracts. This is evidence for review, not an
automatic claim that every dependent needs modification. `check --changed` includes changed files
and their transitive dependents so a changed implementation cannot bypass an unchanged entrypoint
contract.

Rule scopes, contract paths, and budget scopes are repository-relative paths. Guard rejects
absolute paths, `..` traversal, and symlinks that resolve outside the project root. Rule scopes may
target future files, while contract and budget scopes must still exist. `verify` and `audit` validate
these paths and policy definitions before scanning. A stale or unsafe policy is a policy problem,
not a source-code finding, and causes verification to fail.

Import-boundary contracts cover static imports, re-exports, and literal dynamic imports. Repeated
references to the same module are deduplicated into one finding. When TypeScript resolves an alias
or re-export, findings retain the original import specifier and expose the resolved project file as
`resolvedPath`, so an agent can repair the actual boundary without losing source context.

### Proposals and approval

Generate proposals after initialization or a structural change:

```bash
pnpm exec codapult-guard propose --json
```

The proposal includes evidence, confidence, questions, and a freshness marker. Review every
proposal against the actual code. Activate only the decisions the project wants to preserve:

```bash
pnpm exec codapult-guard rules approve no-client-db
pnpm exec codapult-guard contracts approve server-actions-use-auth
```

Proposals become stale when the project changes. Regenerate them rather than approving a proposal
based on old evidence. The CLI and MCP proposal paths protect activation and preserve decision
history; the AI must not activate policy silently.

### Approval trust modes

The default policy is local mode. `confirm: true` or a CLI approval means that the caller
explicitly requested the state change; it does not prove that a human made the decision.

For agent-driven or protected workflows, configure the policy in `rules.json`:

```json
{
  "approval": {
    "mode": "protected",
    "allowMcpApproval": false,
    "requireDistinctActor": true
  }
}
```

In protected mode, MCP can inspect and propose policy but cannot approve it. Approval must go
through the CLI or an external protected review process such as branch protection. Decision
records include the proposal fingerprint, current commit when available, source (`cli`, `mcp`, or
`external`), and optional `GUARD_APPROVER` metadata. When `requireDistinctActor` is enabled, CLI
and permitted MCP approvals require `GUARD_APPROVER`; if the proposal declares `generatedBy` via
`GUARD_PROPOSER`, Guard rejects the same declared actor approving it. These environment variables
are declared provenance, not cryptographic identity verification; reviewer permissions belong to
the host CI/review system.

This separation is intentional: Guard checks that an approval matches the current evidence, while
GitHub or another protected system determines who is authorized to approve it.

See [Policy mutation control](policy-mutations.md) for the machine-readable mutation contract and
the host/CI command boundary that prevents an agent from granting itself a waiver or replacing a
baseline.

### Policy provenance in CI

`verify` normally reads policy from the working tree. For pull requests, pass the protected base
commit:

```bash
codapult-guard verify --policy-base "$BASE_SHA" --json
```

The base snapshot includes `rules.json`, `contracts.json`, `baseline.json`, `waivers.json`, and
`agent.json` when present. Guard uses that snapshot for the verdict and records its revision and
effective fingerprint in the run result and local run manifest. The result also reports whether
the branch changed the policy relative to the base.

Use `--fail-on-policy-change` for a dedicated policy gate. Repository hosting controls such as
CODEOWNERS and protected branches remain responsible for requiring and authorizing the separate
review; Guard does not impersonate a reviewer or verify provider credentials.

Guard also compares verification-sensitive paths against the base. Built-in paths include CI
workflows, CODEOWNERS, package manifests and lockfiles, and common formatter, linter, typecheck,
and test configuration. Add project-specific globs to `protectedPaths` in the base revision's
`.codapult/guard/rules.json`. The `--fail-on-protected-changes` option requires `--policy-base`
and fails if a listed non-workflow path changes, or if a changed contracted workflow fails its
CI integrity checks. JSON output lists the matched paths and reports whether a workflow changed.

For an explicit and classified policy surface, configure `policySurface.paths` in that same base
policy. Each entry has a repository-relative `pattern`, a `kind` (`ci-workflow`, `guard-policy`, `ownership`,
`dependency-input`, `tool-config`, `ignore-config`, `suppression-source`, or `custom`), and a
`severity` (`error` or `warning`). Error entries block when `--fail-on-protected-changes` is set;
warning entries are reported without blocking. The legacy `protectedPaths` list remains supported
and maps to blocking custom entries. Built-in sensitive paths cannot be downgraded by project
configuration. Entries and match details are included in the JSON result and receipt.

The same option reports added `eslint-disable`, `@ts-ignore`, `@ts-nocheck`, `@ts-expect-error`,
`biome-ignore`, and `prettier-ignore` markers in the PR diff. Guard identifies markers but leaves
their semantics to the relevant tool. Changes to or removal of the workflow itself still require
host-enforced required checks and protected review; a workflow cannot guarantee its own integrity.
The supplied workflow template also rejects PR changes to package manifests, common npm/pnpm/Yarn/Bun
lockfiles, package-manager configuration, and workspace install inputs before setting up pnpm or installing
dependencies. Handle those changes in a separate reviewed PR. This does not replace protecting the
workflow in repository settings.

### Required stages and CI integrity

`agent.json` can list required stages in `completionGate.requiredStages`. Supported values are
`runtime`, `project-checks`, `adapters`, `architecture-policy`, `policy-surface`, `ci-integrity`, and
`verification-scope`. The compatibility default requires only `architecture-policy`; skipped required
stages produce `incomplete`, a nonzero CLI exit, and a list in the receipt. Using a base policy
automatically requires the policy-surface comparison. Declaring a GitHub Actions integrity
contract automatically requires the CI audit. Verification scope is always required: Guard hashes
discovered project files and changed paths before running checks, then verifies that the scope
remained stable through the run.

For GitHub Actions, `rules.json` may declare exact workflow paths, a required job, required command
fragments, expected dependencies, permission ceilings, and whether external actions must use full
commit SHA pins. Guard reads this contract and the base workflow from the base policy revision for
PR verification. It compares action refs with that base and classifies additions, removals, or SHA
changes as `policy-weakened` for separate review, even if the new ref is pinned. It classifies
missing protections as `policy-weakened` and unreadable or invalid workflow data as `incomplete`.
It does not evaluate arbitrary GitHub expressions or verify repository settings, so branch
protection or rulesets must still require the status check from the expected source.
The audit rejects `pull_request_target` on a contracted verification workflow because Guard cannot
prove that it never executes untrusted PR content with that event's elevated context.
Local actions cannot use immutable commit SHA references. If the workflow contract disables
`requireFullShaActions` to permit them, add each local action's source directory to `protectedPaths`
in the base policy so a PR cannot change the code being invoked.
The receipt records the effective Guard invocation and project check commands/arguments, with
credential-like values redacted.

The receipt's `verificationScope` contains SHA-256 hashes and paths for files discovered by Guard,
plus changed and deleted paths. Its fingerprint binds the inventory to the effective policy and
Guard version. If a path cannot be hashed or the inventory changes during verification, the
`verification-scope` stage is incomplete and the overall result cannot pass. The receipt includes
hashes and paths but no source contents; it is not signed and does not prove who ran Guard.

### Exporting and signing a verification attestation

`verify --attestation-out <file>` writes a versioned in-toto Statement containing the verification
receipt. It is emitted only when the result is `pass` and the scope is complete and stable. The
Statement subject digest is the SHA-256 fingerprint of the verified content and policy scope; its
predicate embeds the receipt, including per-file digests, policy fingerprint, base commit, Guard
version, and result. The in-toto `predicateType` URI versions the predicate schema independently
from the receipt's numeric `version` field. Consumers should reject unsupported versions rather than
guessing how to interpret them.

On GitHub pull request events, the receipt also records `headSha` and `baseSha` from the event
payload. `mergeSha` is recorded only when `GITHUB_SHA` identifies the checked-out merge result rather
than the PR head. These commit identifiers describe the hosting event context; the content
fingerprint remains authoritative for the exact files and policy Guard hashed. The output contains
paths and hashes, not file contents. The supplied [CI template](guard-ci.yml) exports and uploads
this unsigned statement alongside the JSON receipt when verification passes.

Guard does not sign the Statement. Signing stays in CI so Guard needs no signing key or Sigstore
dependency. The in-toto Statement format does not require GitHub or Sigstore: another CI system can
sign or attest the same exported file with its own trusted mechanism. The workflow below is a
GitHub-specific integration example; its signature verification commands and trust checks apply to
GitHub artifact attestations. For another CI provider, configure its signer and verifier to bind the
statement digest to the expected repository, workflow identity, source revision, and Guard receipt.

#### Install the trusted GitHub Actions workflow

The [trusted PR workflow template](guard-trusted-pr-attestation.yml) independently runs Guard in a
workflow triggered by completion of the ordinary `Guard` workflow. It does not consume artifacts
from that run. It first validates that the event identifies exactly one PR and compares the head and
base repository names. For same-repository PRs, it checks out the PR head, fetches the exact base
commit, installs a fixed Guard version with lifecycle scripts disabled, runs Guard without project
checks, checks that the receipt matches the PR head and base SHAs, and signs the statement in a
separate job.

This attestation covers **Guard's architecture and policy verification only**. The template skips
project checks and does not attest the result of tests, builds, deployments, or other jobs in the
ordinary workflow. It also does not inspect or require that workflow's conclusion. Keep the normal
Guard workflow as a required PR check; configure other required checks separately.

Requirements:

- GitHub Actions is enabled, and the repository or organization policy permits artifact attestations
  and the permissions declared in the template (`id-token: write`, `attestations: write`, and
  `artifact-metadata: write` in the signer job).
- GitHub artifact attestations are available for public repositories on current GitHub plans. Private
  and internal repositories require GitHub Enterprise Cloud; GitHub Enterprise Server is not
  supported by `actions/attest`. Check the current
  [actions/attest support requirements](https://github.com/actions/attest#readme) for plan changes.
- The repository has Guard initialized and its protected base revision contains a valid Guard policy.
- The ordinary pull request workflow is named exactly `Guard` and runs for `pull_request` events. If
  you use a different workflow name, update `workflow_run.workflows` in the template to match it.
- A Guard release tag is available that records PR context for `workflow_run` events. Configure
  both its exact version and the full commit SHA of that tag; the workflow checks that they match.
- The trusted workflow builds Guard from that immutable source commit using its committed pnpm
  lockfile with `--frozen-lockfile`. Lifecycle scripts are disabled during dependency installation.
  The lockfile's package versions and integrity values pin the complete dependency graph.

Copy the template into the project and commit it on the repository's default branch:

```bash
mkdir -p .github/workflows
cp node_modules/@codapult/guard/docs/guard-trusted-pr-attestation.yml \
  .github/workflows/guard-trusted-pr-attestation.yml
```

In **Settings → Secrets and variables → Actions → Variables**, create these repository variables:

- `CODAPULT_GUARD_VERSION`: the exact release version that includes `workflow_run` receipt support,
  without a `v` prefix or range (for example, `0.10.0`).
- `CODAPULT_GUARD_COMMIT`: the full 40-character Git commit SHA that the matching `v<version>` tag
  resolves to.

Both are non-secret values. The workflow fetches the tag from the public Guard repository, confirms
that it resolves to the configured SHA and that the package version matches, then installs from the
Guard repository's frozen pnpm lockfile. If the release tag moves or either value is wrong, the
workflow stops before installing or running Guard. To obtain the commit SHA for a release, fetch the
version tag and resolve its commit, for example:
`git fetch https://github.com/codapult/codapult-guard.git refs/tags/v0.10.0` followed by
`git rev-parse 'FETCH_HEAD^{commit}'`.

Checkout v7 blocks fork PR checkouts in `workflow_run` by default, and this template keeps that
protection enabled. The context job detects a fork by comparing the PR head and base repository names.
If the event has no associated PR, it compares the workflow run's head repository with the event's
base repository; only a clear repository mismatch is treated as an unattached fork. For a detected
fork, the `verify` and `attest` jobs are skipped before checkout, and a separate read-only job adds a
summary explaining that no signed attestation was created. This is an expected skip, not a Guard pass:
the ordinary Guard pull request check remains responsible for its own result. Fork PRs receive no
trusted attestation unless a future version adds a separately reviewed safe lookup and verification
path. Missing or ambiguous PR context, missing repository identity, or invalid SHAs fail closed. The
`verify` job has only `contents: read`, does not run project checks or package lifecycle scripts, and
does not receive signing permissions or secrets. The separate `attest` job signs only after the
verifier has passed and the receipt has been matched to the PR. Do not add commands that execute
files from the PR to the verifier job.

The `workflow_run` event only runs a workflow file present on the default branch. It has a different
trust context from the original PR workflow and can receive more privileges, so keep its permissions
minimal and protect this workflow file with CODEOWNERS/repository rules. GitHub may omit the PR
association in some events; an empty association is treated as a fork only when the trusted event
metadata identifies a different head repository. Otherwise, the context job fails closed and no
attestation is produced. The ordinary PR workflow can still run, but fork support for signed receipts
requires a separately reviewed PR lookup design. Never solve this by running PR-controlled scripts
in the trusted workflow.
Although this template does not execute project files, Guard still parses attacker-controlled source
and configuration. Use GitHub-hosted ephemeral runners and keep verifier and signer permissions at
the template's minimum; parser vulnerabilities remain a residual risk.

The template uses `--fail-on-policy-change` and `--fail-on-protected-changes`. A PR that changes
Guard policy, the trusted workflow, or another protected verification input will therefore receive
no attestation from this workflow. Review such changes through the repository's protected owner
process, merge the approved policy, then verify subsequent source PRs against that base.

The workflow does not create a required check or status on the PR. GitHub branch protection or a
ruleset must require the ordinary Guard check and protect both workflow definitions. The attestation
is additional evidence for consumers that need to verify who ran Guard and which PR content was
checked; it does not replace host-side merge policy.

#### Verify a signed receipt

Find the trusted workflow run for the PR in the Actions tab. Download its
`guard-trusted-pr-attestation` artifact, which contains `guard-verification.intoto.json`. You can
also download it with GitHub CLI. Install `gh`, authenticate it to GitHub, and use an account that
can read the repository's workflow runs and pull requests:

```bash
gh run download RUN_ID --repo ORG/REPO \
  --name guard-trusted-pr-attestation \
  --dir .guard-attestation
```

Verify the signature, repository, signer workflow, and protected source ref:

```bash
gh attestation verify .guard-attestation/guard-verification.intoto.json \
  --repo ORG/REPO \
  --signer-workflow ORG/REPO/.github/workflows/guard-trusted-pr-attestation.yml \
  --source-ref refs/heads/main
```

The command above verifies the signed artifact file and its GitHub workflow identity. To also check
the embedded Guard receipt's schema version, passing outcome, complete and stable scope, scope digest,
and the exact PR head and base SHAs, copy the bundled consumer script and run it after downloading
the artifact:

```bash
cp node_modules/@codapult/guard/docs/verify-guard-attestation.mjs .guard-attestation/
node .guard-attestation/verify-guard-attestation.mjs \
  .guard-attestation/guard-verification.intoto.json \
  --repo ORG/REPO \
  --signer-workflow ORG/REPO/.github/workflows/guard-trusted-pr-attestation.yml \
  --source-ref refs/heads/main \
  --expected-head HEAD_SHA \
  --expected-base BASE_SHA
```

The script calls `gh attestation verify` with the repository, signer workflow, and source-ref
constraints before inspecting the statement. It exits nonzero if signature verification fails or if
the embedded statement is unsupported, unsuccessful, incomplete, unstable, or bound to different
PR SHAs. Obtain the expected head and base values from the current PR; do not copy them from the
receipt being checked.

Replace `ORG/REPO` and `main` with the repository and protected default branch. This command checks
that the attestation is for the exact downloaded statement file and that the signer identity matches
the expected workflow and ref. Then compare the embedded receipt with the PR revision you intend to
accept. Set `EXPECTED_HEAD_SHA` and `EXPECTED_BASE_SHA` to the PR's current head and base commit SHAs
using the GitHub API:

```bash
EXPECTED_HEAD_SHA=$(gh api repos/ORG/REPO/pulls/PR_NUMBER --jq .head.sha)
EXPECTED_BASE_SHA=$(gh api repos/ORG/REPO/pulls/PR_NUMBER --jq .base.sha)
```

Replace `ORG/REPO` and `PR_NUMBER`, then run:

```bash
jq -e \
  --arg head "$EXPECTED_HEAD_SHA" \
  --arg base "$EXPECTED_BASE_SHA" \
  '.predicateType == "https://codapult.dev/attestations/guard-verification/v1" and
   .predicate.receipt.outcome == "pass" and
   .predicate.receipt.subject.headSha == $head and
   .predicate.receipt.subject.baseSha == $base and
   .predicate.receipt.verificationScope.complete == true and
   .predicate.receipt.verificationScope.stable == true and
   .subject[0].digest.sha256 == .predicate.receipt.verificationScope.fingerprint' \
  .guard-attestation/guard-verification.intoto.json >/dev/null
```

The comparison must use the exact PR revisions being reviewed. If the PR head or target branch has
advanced since the workflow ran, require a new trusted workflow run and verify its receipt instead.
The statement's `mergeSha`, when present, identifies the merge commit checked by Guard; the head and
base SHA checks above bind the attestation to the PR revisions.

For a first setup check, open a test PR from a branch in the same repository, wait for both workflow
runs to finish, confirm that `guard-trusted-pr-attestation` appears as an artifact on the trusted
workflow run, download it, and run both verification commands above. This template intentionally
fails closed when it cannot identify exactly one associated PR, when the Guard receipt is not a
pass, when its scope is incomplete or unstable, or when the PR SHAs do not match the event.

Signature verification proves which workflow signed the statement and that the statement file was
not changed after signing. It does not, by itself, prove that arbitrary claims inside the statement
are true. This template acts as the trusted verifier by re-running Guard before signing. Do not give
`id-token: write` to a job that executes PR-controlled workflow code and treat its signature as
trusted verification: a `pull_request` workflow file comes from the PR merge commit. GitHub also
warns that predicates may be controlled by the workflow that produced them unless signing is done
by a trusted builder. See GitHub's [guidance on untrusted code checkout](https://docs.github.com/en/actions/reference/security/secure-use#mitigating-the-risks-of-untrusted-code-checkout),
[workflow_run event details](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run),
the [in-toto Statement spec](https://github.com/in-toto/attestation/blob/main/spec/README.md),
[GitHub artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations),
[actions/attest](https://github.com/actions/attest), and
[gh attestation verify](https://cli.github.com/manual/gh_attestation_verify).

### Governance audit

Use the read-only governance audit to inspect whether approval records retain enough declared
provenance for later review:

```bash
codapult-guard governance --json
codapult-guard governance --strict
```

The report counts declared proposal authors and approval actors, identifies overlaps, missing
actors/authors/commits, checks policy fingerprints, and follows retained `decision ID → verification
run` links. `--strict` exits non-zero when the report contains completeness warnings. The audit
reports metadata recorded by Guard; it does not prove personal identity, cryptographic signatures,
a trusted clock, immutable storage, or authorization. Those guarantees belong to Git, CI, branch
protection, and the review platform.

## What Guard discovers

Guard is intentionally evidence-driven. It can model a small JavaScript utility, a React app, a
Next.js App Router SaaS, a Node service, or a workspace without requiring one fixed architecture.

The TypeScript AST path uses `ts-morph` where AST semantics are useful. Lightweight file/config/Git
inspection remains direct code because introducing a large parser for a small fact would add cost
without improving accuracy. This hybrid boundary is deliberate.

The model is useful for questions such as:

- Which changed routes, actions, services, repositories, or tests are affected?
- Which client modules cross a server-only boundary?
- Which dependencies, environment variables, schemas, or configs are connected to a change?
- Which capabilities are actually present, and what files provide the evidence?
- Are there cycles, layer violations, high-fan-out modules, or changed impact paths?
- Which modules depend on a changed module, and which callers may be affected transitively?
- How did the project model, module graph, and layer edges change between two saved snapshots?

Domain signals for payments, auth, jobs, email, AI, storage, database, deployment, security,
observability, and other areas are review context by default. They do not become blocking rules
merely because a package name or filename resembles a domain.

## AI-agent and MCP workflow

MCP exposes the same Guard model without requiring the host to parse CLI output. The Guard tools
are:

| MCP tool                         | Purpose                                                                                                        | Writes by default?                                                |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `codapult_guard_context`         | Read explicitly separated observations, proposals, active policy, and verification state.                      | No                                                                |
| `codapult_guard_analyze`         | Refresh persisted facts and snapshots without changing policy or baseline.                                     | Requires `confirm: true`.                                         |
| `codapult_guard_propose`         | Generate evidence-based proposals.                                                                             | No; persistence requires `persist: true` and `confirm: true`.     |
| `codapult_guard_init`            | Initialize Guard.                                                                                              | Requires `confirm: true`; force also requires confirmation.       |
| `codapult_guard_proposal_decide` | Approve/reject current proposals.                                                                              | Requires `confirm: true`; protected mode can forbid MCP approval. |
| `codapult_guard_check`           | Check active Guard policy and changed files.                                                                   | No                                                                |
| `codapult_guard_review`          | Prepare a bounded/redacted semantic review packet.                                                             | No                                                                |
| `codapult_guard_verify`          | Run the completion gate and return structured results.                                                         | Runs configured project commands; does not edit source.           |
| `codapult_guard_governance`      | Audit declared approval provenance and decision-to-verification reachability.                                  | No                                                                |
| `codapult_guard_audit`           | Full current scan and contract validation.                                                                     | No                                                                |
| `codapult_guard_waivers`         | List or manage owner-attributed, time-bounded exceptions to exact finding fingerprints.                        | Writes require confirmation and policy approval.                  |
| `codapult_guard_impact`          | Explain dependencies, transitive dependents, impact paths, capabilities, contracts, and graph edges for files. | No                                                                |
| `codapult_guard_explain`         | Explain one rule/contract, its evidence, and suggested next steps.                                             | No                                                                |
| `codapult_guard_next_action`     | Return the next bounded Guard action for an agent without changing project state.                              | No                                                                |

Every tool accepts an optional `root`. If omitted, the MCP process working directory is used. The
host should pass a project root when its MCP process is not started there.

`codapult_guard_context` keeps four states separate:

- `observations`: facts discovered from the current project. They have `status: "observed-only"`
  and are not enforced merely because a pattern is common.
- `proposals`: rules and contracts suggested from evidence. Only pending items appear in
  `pendingRules` and `pendingContracts`; they have `status: "pending-approval"` and
  `requiresApproval: true`. Decided proposal history is not presented as pending policy.
- `policy`: active rules and contracts, plus baseline and waiver state. Only this policy is used
  for deterministic enforcement.
- `verification`: the status of an actual check. Context reads state and returns
  `status: "not-run"` with `findings: null`; call `codapult_guard_check` or
  `codapult_guard_verify` for findings.

This distinction prevents an observed convention from being mistaken for an approved rule or a
context response from being mistaken for a passing verification.

### Registering the MCP server

Install Guard in the project that the agent will inspect:

```bash
pnpm add -D @codapult/guard
```

Guard exposes a local stdio MCP server through the `codapult-guard` executable:

```bash
pnpm exec codapult-guard mcp-server
```

Register that command in the selected AI host and use the project root as its working directory.
For example, Cursor can use `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "codapult-guard": {
      "type": "stdio",
      "command": "pnpm",
      "args": ["exec", "codapult-guard", "mcp-server"],
      "cwd": "${workspaceFolder}"
    }
  }
}
```

For a client with a generic stdio configuration, use the same command and set `cwd` to the
repository root. Do not use `@codapult/cli` for standalone Guard projects: that package is the
Codapult SaaS CLI and is a separate integration. Host-specific setup and instruction files are
available in [`docs/integrations/`](integrations/README.md).

Guard is also discoverable in the official [MCP Registry](https://registry.modelcontextprotocol.io/?q=io.github.codapult%2Fguard)
as `io.github.codapult/guard`. Registry discovery identifies the published npm-backed server; the
selected host still needs a local installation and stdio configuration with the project root.

After connecting, verify the server by calling `codapult_guard_context` or
`codapult_guard_audit`. If the MCP process starts outside the repository, pass the absolute
project path as the tool's `root` argument.

Recommended agent sequence:

```text
task complete
  → codapult_guard_next_action
  → codapult_guard_context
  → codapult_guard_review(requirement, diff)
  → codapult_guard_verify(iteration: 1)
  → if fail and canRetry: repair, then repeat with iteration + 1
  → report warnings and unresolved requirements
```

The host agent owns the loop, model call, permissions, and source edits. Guard does not invoke an
LLM, silently loop, or repair files. `agent.json` supplies policy such as `enabled`,
`maxIterations`, `projectChecks`, selected checks, and external-tool mode. A host may use the
managed instruction block:

```bash
pnpm exec codapult-guard install-agent codex
pnpm exec codapult-guard install-agent cursor
pnpm exec codapult-guard install-agent all
```

Supported targets are `generic`, `codex`, `cursor`, `claude`, `copilot`, and `gemini`. The managed
block is marker-based and updates only its own section. Host-specific MCP registration and
completion-hook behavior are documented in the [integration kits](integrations/README.md).

An agent instruction can be as short as:

```text
Before declaring a task complete, call codapult_guard_next_action, then
follow its bounded next step. Normally call codapult_guard_context,
codapult_guard_review with the requirement and diff, then codapult_guard_verify.
If verification fails and canRetry is true, repair the code and repeat up to
completionGate.maxIterations. Report warnings and unresolved requirements.
```

## CI and machine-readable output

CI should independently run Guard after an AI agent finishes. Do not accept an agent's statement
that a finding was fixed; accept the next deterministic result.

JSON gate output:

```bash
pnpm exec codapult-guard verify --json
pnpm exec codapult-guard check --changed --json
```

`verify --json` includes a `run` object with a unique run ID, stage durations, outcome, and the
policy gate that determined the result. The same manifest is saved under
`.codapult/guard/history/runs/`. Guard keeps this diagnostic record local and does not send traces
or source code to a remote service. The manifest includes a compact `verification-receipt` with the
checked commit, policy fingerprint/base, decision IDs, check statuses, finding and waiver counts,
contract issue IDs, Guard version, and a SHA-256 inventory of verification inputs. It is an
explainability artifact, not a signed proof of CI identity. With `--policy-base`, the receipt also distinguishes `baseChangedFiles` from
`workingTreeFiles`; this makes a dirty local checkout visible in the machine-readable result.

SARIF output for GitHub Code Scanning or another SARIF consumer:

```bash
pnpm exec codapult-guard check --changed --sarif > guard-results.sarif
```

The repository includes a copyable consumer workflow at [`docs/guard-ci.yml`](guard-ci.yml). On pull
requests it installs dependencies without lifecycle scripts and runs the deterministic Guard gate
without executing PR-owned project scripts; trusted pushes can run configured project checks. It uploads SARIF
with `github/codeql-action/upload-sarif` and also runs the unified verification gate. Projects
using protected or forked pull requests should review their `security-events: write` permissions
and artifact policy.

For maintainers, the fixture and real-PR harnesses are documented in
[`guard-fixtures.md`](guard-fixtures.md). The isolated golden flow is run with:

```bash
pnpm test:guard:golden
```

## Security and data handling

- Guard excludes `.env`, credential/secret-named files, and common private-key extensions from
  review diffs.
- Common credential-shaped values are redacted before a review packet or structured output is
  returned. Redaction is a defense-in-depth measure, not a guarantee that arbitrary secrets are
  recognized.
- Requirement files must remain inside the detected project root and are size-limited.
- Git base refs are validated before being used by review commands.
- Project checks and external adapters execute the project's own scripts. Run Guard only in a
  trusted workspace and review scripts before enabling `tools: auto` or `tools: on`.
- MCP roots are local filesystem paths supplied by the host. Run the MCP server with the least
  filesystem access appropriate for the projects it serves.
- Guard does not send source code to a remote service by itself. An AI host may send the review
  packet to its configured model; apply that host's data-retention and provider policy.

## Troubleshooting

### `Guard is not initialized`

Run `codapult-guard init` from the project root. For MCP, pass the correct `root` or start the server in
the project directory.

### `Guard is already initialized`

This is intentional protection. Use `codapult-guard analyze` to refresh facts, or use `codapult-guard init --force`
only when replacing the baseline is a deliberate decision.

### Too many findings appear after initialization

That is the expected baseline boundary: old findings are recorded and suppressed by `check`, while
new regressions remain visible. Use `codapult-guard audit` to inspect the complete current state.

### A proposal is stale

The code changed after the proposal was generated. Run `codapult-guard propose` again and review the new
evidence.

### Verification says a tool is not configured

Use `--tools auto` for normal operation, `--tools off` when external adapters are not relevant,
or `--strict` when the project requires every selected check/adapter to exist.

### Review says the diff is truncated or redacted

This is intentional. Review packets are bounded, and sensitive-looking content is removed before
it reaches an AI reviewer. Narrow the change or inspect the source locally if more context is
needed.

### Native fixture checks fail because of Node

Fixture projects retain their own engine requirements. Use a compatible Node version for the
fixture rather than weakening Guard or changing the fixture's production configuration. Guard's
runtime diagnostic reports the active and declared versions.

## Implementation boundaries

Guard currently provides deterministic discovery, policy checks, project-context packets, contract
validation, completion-gate orchestration, MCP exposure, JSON/SARIF output, and host instruction
templates. It intentionally does not:

- call an LLM or choose architectural policy without approval;
- replace specialist linters, type checkers, test runners, SAST, dependency scanners, or builds;
- silently rewrite source code or automatically reset a baseline;
- guarantee semantic correctness from filename/package-name heuristics alone;
- implement host-specific agent hooks as runtime dependencies.

That boundary keeps Guard local-first, model-agnostic, and project-specific while allowing existing
tools and AI platforms to remain useful adapters around one shared project model.
