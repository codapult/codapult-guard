# @codapult/guard

[![CI](https://github.com/codapult/codapult-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/codapult/codapult-guard/actions/workflows/ci.yml)
[![Fixtures](https://github.com/codapult/codapult-guard/actions/workflows/guard-fixtures.yml/badge.svg)](https://github.com/codapult/codapult-guard/actions/workflows/guard-fixtures.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js >=20.19](https://img.shields.io/badge/node-%3E%3D20.19-339933.svg?logo=node.js&logoColor=white)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-first-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

## Architecture guardrails for AI coding agents

`@codapult/guard` is a local-first, model-agnostic architecture guard for JavaScript and
TypeScript projects.

It learns what already exists, records the project’s architectural memory, and protects future
changes from introducing regressions.

> **Guard does not tell every project to use the same architecture.**
> It discovers the architecture that is already there, then lets the team decide what becomes policy.

The core is universal. The strongest first-class scenarios are Next.js SaaS and AI-assisted
development, including server/client boundaries, routes, persistence, authentication, billing,
background jobs, environment configuration, and AI integrations.

## Part of the Codapult ecosystem

Guard is an independent open-source project from [Codapult](https://codapult.dev). It does not
require Codapult and can be installed in any JavaScript or TypeScript repository.

The relationship is complementary:

| Project               | Role                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------- |
| **`@codapult/guard`** | Universal architecture guardrails, project memory, contracts, MCP, and AI-agent context. |
| **`@codapult/cli`**   | Codapult SaaS project CLI that includes Guard through a thin adapter.                    |
| **Codapult**          | Full-source Next.js SaaS foundation with conventions Guard can discover and protect.     |

Use standalone Guard for any compatible project. Use the Codapult CLI when working on a Codapult
SaaS project and you want project management, database, plugins, deployment, MCP, and Guard in one
CLI.

```text
        Existing project
              │
              ▼
       deterministic discovery
     AST · files · imports · Git
              │
              ▼
        project architecture
  capabilities · graph · impact paths
              │
              ▼
       approved project policy
  rules · contracts · conventions · baseline
              │
              ▼
          change verification
   check · review packet · verify · CI
```

## Why Guard exists

AI agents can produce syntactically valid code that still violates the architecture of a real
project: a client component imports server-only code, a new action bypasses the established auth
boundary, a route writes to the database directly, or a change duplicates a service that already
exists.

Existing tools remain essential, but they solve different problems:

| Tool category              | Primary question                                   | Guard’s relationship                                                  |
| -------------------------- | -------------------------------------------------- | --------------------------------------------------------------------- |
| TypeScript                 | Is the code type-correct?                          | Uses the project’s typecheck as an optional gate.                     |
| ESLint / Biome             | Does code follow language and style rules?         | Does not duplicate their lint rules.                                  |
| Tests                      | Does behavior match executable expectations?       | Runs configured checks when enabled; does not replace tests.          |
| SAST / dependency scanners | Is there a known security or dependency risk?      | Can connect adapters; focuses on architecture and change impact.      |
| PR review services         | What semantic concerns should a reviewer consider? | Produces a bounded, redacted review packet for the selected AI host.  |
| **Guard**                  | Is the project becoming architecturally worse?     | Maintains project-specific architectural memory and regression gates. |

## Install

Requirements: Node.js `>=20.19` and a JavaScript or TypeScript project.

```bash
pnpm add -D @codapult/guard
# or
npm install --save-dev @codapult/guard
```

The package exposes the `codapult-guard` binary:

```bash
pnpm exec codapult-guard init
```

The npm package is scoped as `@codapult/guard`; the executable intentionally remains
`codapult-guard` for discoverability and consistency with the standalone product name.

## 60-second quick start

Run from the project root:

```bash
# 1. Build the initial project model and baseline
pnpm exec codapult-guard init

# 2. Inspect only new and changed architecture findings
pnpm exec codapult-guard check --changed

# 3. Prepare deterministic context for an AI review
pnpm exec codapult-guard review --requirement docs/acceptance.md

# 4. Run the configured completion gate
pnpm exec codapult-guard verify --json
```

`init` is protected and refuses to overwrite an existing baseline. Use `init --force` only when
deliberately replacing the project memory. Use `analyze` to refresh discovered facts without
resetting the baseline.

## The operating model

Guard separates facts, policy, verification, and decision:

| Layer            | Contains                                                                           | How it is produced                             |
| ---------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------- |
| **Facts**        | AST, files, imports, dependencies, routes, calls, capabilities, graph, Git history | Deterministic local discovery                  |
| **Policy**       | Rules, contracts, conventions, baseline                                            | Observed proposals plus explicit team approval |
| **Verification** | Changed-file checks, impact analysis, contracts, project checks, review packet     | Local CLI, MCP, CI, and existing project tools |
| **Decision**     | Pass, fail, warning, needs-review, not-configured                                  | Developer or AI host using Guard evidence      |

Guard does not assume a fixed `UI → actions → services → repositories → database` architecture.
It can discover that shape when the project exhibits it, but observed patterns become enforceable
only after explicit approval.

## What Guard discovers

The model is framework-aware without being framework-dependent:

| Area                    | Examples of discovered evidence                                                    |
| ----------------------- | ---------------------------------------------------------------------------------- |
| JavaScript / TypeScript | AST modules, declarations, calls, directives, aliases, re-exports, dynamic imports |
| Next.js / React         | App Router routes, route methods, Server Actions, client/server boundaries         |
| API boundaries          | Route handlers, API modules, entrypoints, impact paths                             |
| Data                    | ORM packages, schemas, migrations, repositories, persistence boundaries            |
| Capabilities            | Auth, payments, email, AI/RAG, queues, storage, cache, search, analytics, content  |
| Operations              | Environment references, configs, deployment, observability, webhooks               |
| Repository shape        | Workspaces, package scripts, dependencies, cycles, import hotspots, Git history    |
| Testing                 | Test files, test scripts, workspace checks, changed files                          |

Capabilities are evidence, not requirements. A Vite app, Express service, Hono project, Node
package, monorepo, or Next.js SaaS can all use the same Guard core.

## The normal loop

```text
init once → edit → check --changed → review → verify → commit / merge
                         ↘ analyze after structural changes
```

1. `init` builds project memory and establishes the initial baseline.
2. `check --changed` is the fast deterministic architecture gate.
3. `review` prepares a bounded and redacted diff packet for an AI host; it does not call an LLM.
4. `verify` runs Guard policy, configured project checks, adapters, runtime diagnostics, and
   contract validation.
5. `audit` inspects the complete current state, including findings accepted by the baseline.

Guard state is stored in `.codapult/guard/`:

```text
.codapult/guard/
├── project.json       discovered project model
├── architecture.json  observed architecture and capabilities
├── conventions.json   recurring project conventions
├── rules.json         active and proposed deterministic rules
├── contracts.json     project-specific boundaries and required calls
├── proposals.json     evidence and approval history
├── baseline.json      accepted pre-existing findings
├── agent.json         AI-host completion-gate configuration
└── history/           project snapshots for comparison
```

Commit policy and baseline files when the team wants shared guardrails. Treat cache artifacts as
disposable according to the project’s policy, and never commit secrets.

## AI agents and MCP

Guard is deliberately model-agnostic. It does not send source code to a remote LLM and does not
edit source files by itself. The AI host owns the model call, permissions, repair loop, and final
decision.

Start the standalone MCP server over stdio:

```bash
pnpm exec codapult-guard mcp-server
```

Recommended agent loop:

```text
task finished
  → codapult_guard_context
  → codapult_guard_review(requirement, diff)
  → codapult_guard_verify
  → repair reported failures
  → repeat until pass or bounded iteration limit
```

For Cursor, Claude Code, Codex, Gemini CLI, GitHub Copilot, and generic hosts, see
[`docs/integrations/`](docs/integrations/).

## CI

Copy the consumer workflow into a project that has installed and initialized Guard:

```bash
cp node_modules/@codapult/guard/docs/guard-ci.yml .github/workflows/guard.yml
```

Or copy it from [`docs/guard-ci.yml`](docs/guard-ci.yml). It runs project verification and exports
Guard findings as SARIF for GitHub code scanning.

The package repository separately runs its own unit, typecheck, build, and packaging checks in
[`.github/workflows/ci.yml`](.github/workflows/ci.yml), while the fixture workflow tests Guard on
real project shapes.

## CLI surface

| Command                    | Purpose                                                         |
| -------------------------- | --------------------------------------------------------------- |
| `init`                     | Create project memory and the initial baseline.                 |
| `analyze`                  | Refresh facts without changing policy or baseline.              |
| `propose`                  | Generate evidence-based rule and contract proposals.            |
| `check --changed`          | Enforce active policy on changed and untracked files.           |
| `audit`                    | Scan the complete current project, including baseline findings. |
| `review`                   | Create a bounded semantic-review packet for an AI host.         |
| `verify`                   | Run the configured completion gate.                             |
| `doctor`                   | Diagnose invalid or missing Guard artifacts.                    |
| `history` / `history-diff` | Inspect project model evolution.                                |
| `rules` / `contracts`      | Approve or reject proposed policy.                              |
| `baseline`                 | Review or intentionally accept existing findings.               |

Run `pnpm exec codapult-guard <command> --help` for command-specific options.

## Security and data handling

- Deterministic discovery and checks run locally.
- Review packets are bounded and redact common secrets before they are returned to an AI host.
- Guard does not invoke an LLM or require a provider API key.
- Project commands and external adapters run only when enabled by the project configuration.
- Existing findings can be baselined, but new regressions remain visible.

## Verification and proof

The repository validates the product through multiple layers:

- unit and integration tests for discovery, policy, baseline, verification, MCP, and output;
- AST adversarial cases for aliases, re-exports, dynamic imports, and route boundaries;
- golden end-to-end flow from violation to repair;
- mutation regression checks across real Next.js, React/Vite, Node, Hono, monorepo, and Express
  repositories;
- npm pack checks to ensure the published artifact contains only the intended build output.

Run the maintainer checks locally:

```bash
pnpm test
pnpm test:guard:golden
pnpm test:guard:fixtures
pnpm test:guard:fixtures:regression
pnpm release:check
```

## Documentation

- [Complete Guard guide](docs/guard.md)
- [AI-agent integration](docs/guard-agent-integration.md)
- [Host integrations](docs/integrations/)
- [CI consumer workflow](docs/guard-ci.yml)
- [Fixture matrix](docs/guard-fixtures.md)
- [Release process](docs/releasing.md)

## Project status

`@codapult/guard` starts at `0.1.0` as a public alpha. The deterministic core is usable, tested,
and intended for real projects, while policy schema and integration surfaces may still evolve
before `1.0.0`.

## License

MIT. See [LICENSE](LICENSE).
