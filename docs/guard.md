# Codapult Guard

Codapult Guard is a local-first architecture guardrail and project-context system for JavaScript
and TypeScript repositories. It observes the architecture that already exists, records project
memory, checks changes against approved project policy, and prepares bounded context for an AI
reviewer.

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

| File                 | Purpose                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `project.json`       | Persisted discovered project model: files, modules, dependencies, routes, capabilities, patterns, Git data, and insights. |
| `architecture.json`  | Human/agent-readable architecture memory derived from observed project facts.                                             |
| `conventions.json`   | Observed conventions and recurring project patterns.                                                                      |
| `rules.json`         | Guard rules. Rules with `status: "active"` are enforced; `proposed` rules are not.                                        |
| `contracts.json`     | Project-specific guidance, import boundaries, and required-call contracts.                                                |
| `proposals.json`     | Evidence, confidence, questions, and approval/rejection history for proposed policy.                                      |
| `baseline.json`      | Fingerprints of accepted pre-existing findings. Baseline suppression is fingerprint-based.                                |
| `baseline-meta.json` | Metadata describing the baseline and its project snapshot.                                                                |
| `agent.json`         | Host-facing completion-gate and external-tool policy. It does not execute an LLM.                                         |
| `cache.json`         | Optional discovery cache. Unchanged AST modules can be reused by content hash.                                            |
| `history/`           | Project model snapshots used by `history-diff`.                                                                           |

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

Compare persisted project states:

```bash
pnpm exec codapult-guard history
pnpm exec codapult-guard history-diff <from> <to>
```

## Command reference

All commands return a non-zero exit code when their decision is blocking. Add `--json` where the
command supports it for automation.

| Command                                    | Use                                                                                            |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `codapult-guard init`                      | Create Guard state and establish the initial baseline. Refuses an existing baseline.           |
| `codapult-guard init --force`              | Replace existing Guard state intentionally.                                                    |
| `codapult-guard analyze`                   | Refresh persisted discovery, architecture, conventions, and snapshot. Does not alter baseline. |
| `codapult-guard propose`                   | Generate evidence-based rules/contracts for review. Does not activate them.                    |
| `codapult-guard doctor`                    | Diagnose missing, invalid, or unsupported Guard artifacts.                                     |
| `codapult-guard history`                   | List persisted project snapshots.                                                              |
| `codapult-guard history-diff <from> <to>`  | Compare files, dependencies, capabilities, and cycles.                                         |
| `codapult-guard check [--changed]`         | Enforce active Guard rules/contracts and report new findings.                                  |
| `codapult-guard audit`                     | Run a full current Guard scan without baseline suppression and validate contracts.             |
| `codapult-guard review`                    | Produce a bounded diff + project-context packet for semantic AI review.                        |
| `codapult-guard review --base origin/main` | Build the review packet from a PR base ref.                                                    |
| `codapult-guard verify`                    | Run Guard, project checks, adapters, runtime, and contract verification as configured.         |
| `codapult-guard rules approve <ids>`       | Activate selected proposed rules.                                                              |
| `codapult-guard rules approve --all`       | Activate every proposed rule deliberately.                                                     |
| `codapult-guard contracts approve <ids>`   | Activate selected proposed contracts.                                                          |
| `codapult-guard contracts reject <ids>`    | Record rejection for selected proposed contracts.                                              |
| `codapult-guard install-agent <target>`    | Add or update a managed Guard instruction block for an AI host.                                |

`codapult-guard review` does not call an LLM. It creates input for one. A review packet includes changed
files, a bounded/redacted diff, project model, contracts, deterministic findings, and review
instructions. If the Git base is invalid, the packet contains `diffError` and has a failing
outcome.

Manage baseline entries without rebuilding the entire project state:

```bash
pnpm exec codapult-guard baseline list
pnpm exec codapult-guard baseline accept <fingerprint> --reason "Accepted legacy boundary"
pnpm exec codapult-guard baseline remove <fingerprint> --reason "Fixed in the current architecture"
```

Use `--all` only as an explicit decision. `baseline accept --all` accepts all findings from the
current full scan; `baseline remove --all` removes fingerprints represented by the current scan.
Each update preserves a decision record in `baseline-meta.json`.

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

Scopes, entrypoints, exclusions, and references are repository-relative paths. `verify` and
`audit` validate that these paths still exist and that contract definitions contain the required
fields. A stale contract is a policy problem, not a source-code finding, and causes verification
to fail.

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
- How did the project model change between two saved snapshots?

Domain signals for payments, auth, jobs, email, AI, storage, database, deployment, security,
observability, and other areas are review context by default. They do not become blocking rules
merely because a package name or filename resembles a domain.

## AI-agent and MCP workflow

MCP exposes the same Guard model without requiring the host to parse CLI output. The Guard tools
are:

| MCP tool                         | Purpose                                                                        | Writes by default?                                            |
| -------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `codapult_guard_context`         | Read current project facts, policy, architecture, and completion config.       | No                                                            |
| `codapult_guard_propose`         | Generate evidence-based proposals.                                             | No; persistence requires `persist: true` and `confirm: true`. |
| `codapult_guard_init`            | Initialize Guard.                                                              | Requires `confirm: true`; force also requires confirmation.   |
| `codapult_guard_proposal_decide` | Approve/reject current proposals.                                              | Requires `confirm: true`.                                     |
| `codapult_guard_check`           | Check active Guard policy and changed files.                                   | No                                                            |
| `codapult_guard_review`          | Prepare a bounded/redacted semantic review packet.                             | No                                                            |
| `codapult_guard_verify`          | Run the completion gate and return structured results.                         | Runs configured project commands; does not edit source.       |
| `codapult_guard_audit`           | Full current scan and contract validation.                                     | No                                                            |
| `codapult_guard_impact`          | Explain modules, impact paths, capabilities, and relevant contracts for files. | No                                                            |
| `codapult_guard_explain`         | Explain one rule/contract, its evidence, and suggested next steps.             | No                                                            |

Every tool accepts an optional `root`. If omitted, the MCP process working directory is used. The
host should pass a project root when its MCP process is not started there.

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
      "command": "pnpm",
      "args": ["exec", "codapult-guard", "mcp-server"],
      "cwd": "."
    }
  }
}
```

For a client with a generic stdio configuration, use the same command and set `cwd` to the
repository root. Do not use `@codapult/cli` for standalone Guard projects: that package is the
Codapult SaaS CLI and is a separate integration. Host-specific setup and instruction files are
available in [`docs/integrations/`](integrations/README.md).

After connecting, verify the server by calling `codapult_guard_context` or
`codapult_guard_audit`. If the MCP process starts outside the repository, pass the absolute
project path as the tool's `root` argument.

Recommended agent sequence:

```text
task complete
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
post-task hook syntax remain the responsibility of that AI platform. See the [integration kits](integrations/README.md).

An agent instruction can be as short as:

```text
Before declaring a task complete, call codapult_guard_context, then
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

SARIF output for GitHub Code Scanning or another SARIF consumer:

```bash
pnpm exec codapult-guard check --changed --sarif > guard-results.sarif
```

The repository includes a copyable consumer workflow at [`docs/guard-ci.yml`](guard-ci.yml). It uploads SARIF
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
