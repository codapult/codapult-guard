# @codapult/guard

[![CI](https://github.com/codapult/codapult-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/codapult/codapult-guard/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@codapult/guard?logo=npm)](https://www.npmjs.com/package/@codapult/guard)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js >=20.19](https://img.shields.io/badge/node-%3E%3D20.19-339933.svg?logo=node.js&logoColor=white)](package.json)

## Architecture guardrails for AI-assisted development

Codapult Guard helps teams preserve the architecture that makes their project work as it changes.
It maps a JavaScript or TypeScript codebase, lets the team approve project-specific boundaries, and
checks future changes locally and in CI. AI agents can use the same project context and verification
results as developers.

### Catch project-specific regressions

A type checker can confirm that code is valid TypeScript. It cannot know that this project requires
client components to stay away from persistence modules. Once the team approves that boundary,
Guard can detect a violating import in changed files and show which rule was triggered.

```text
Project boundary:  Client → Server Action → Service → Repository → Database
Possible regression: Client ─────────────────────────────────────→ Database
```

Guard discovers the architecture in the repository; it does not prescribe one universal structure
or activate proposed rules without approval.

## Get started

Requirements: Node.js `>=20.19` and a JavaScript or TypeScript project.

```bash
# pnpm
pnpm add -D @codapult/guard
pnpm exec codapult-guard init

# npm
npm install --save-dev @codapult/guard
npx codapult-guard init
```

Review the generated project model, proposed rules, contracts, and baseline under
`.codapult/guard/` before relying on the results. Then run Guard's architecture checks:

```bash
pnpm exec codapult-guard verify --no-project-checks --tools off
```

`verify` can run your configured project checks and detected adapters. The flags above limit this
run to Guard's built-in checks. With npm, run `npx codapult-guard verify --no-project-checks --tools off`.
See the [complete guide](docs/guard.md#install-and-initialize) for initialization and daily workflows.

## Use Guard with an AI agent

Install a managed instruction block for your agent so it knows when to load Guard context and run
verification:

```bash
pnpm exec codapult-guard install-agent codex
```

Supported hosts and MCP setup are in the [AI-agent integration guide](docs/guard-agent-integration.md)
and [host integration guides](docs/integrations/).

The MCP server uses host-managed local stdio, with no network listener or application-level
authentication. The host and operating system control process access and workspace permissions;
see the [security model](docs/guard.md#security-and-authentication).

## Choose a GitHub setup

Choose a preset from the existing workflow templates and follow only the hosting steps for that
level of protection. Most projects can start with standard PR checks.

| Preset                      | Use it when                                                                         | Guide                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **PR checks**               | You want Guard findings and a required check on ordinary pull requests.             | [GitHub PR checks](docs/github-setup-presets.md#github-pr-checks)        |
| **Trusted PR verification** | The Guard check must come from a protected workflow source, including for fork PRs. | [Trusted PR setup](docs/github-setup-presets.md#trusted-pr-verification) |
| **Merge queue**             | Your repository merges through a GitHub merge queue.                                | [Merge queue setup](docs/github-setup-presets.md#merge-queue)            |

If you are unsure, use **PR checks** first. It is useful CI feedback, but its workflow lives in the
project being checked and can be changed by a pull request. Choose trusted verification when the
check itself must be protected from that change.

## What Guard does

- Learns project-specific structure, dependencies, boundaries, and existing findings.
- Checks approved architecture rules and contracts without imposing a universal architecture.
- Shows change impact and prepares bounded, redacted context for AI review.
- Runs configured project checks and adapters when enabled; it does not replace them.
- Produces deterministic CLI, JSON, and SARIF results for local use and CI.

Guard is local-first and does not call an LLM. The AI host owns model access, edits, and its repair
loop. Guard complements TypeScript, ESLint or Biome, tests, SAST, and dependency scanners; it does
not replace them.

## Documentation

- [GitHub setup presets](docs/github-setup-presets.md) — choose and configure the CI level you need.
- [Complete Guard guide](docs/guard.md) — commands, policy, results, security, and advanced workflows.
- [AI-agent integration](docs/guard-agent-integration.md) — managed instructions and MCP workflow.
- [Host integrations](docs/integrations/) — Codex, Cursor, Claude Code, Copilot, Gemini CLI, and generic MCP clients.
- [Policy mutation controls](docs/policy-mutations.md) — approval and protected policy behavior.
- [Extensions](docs/extensions.md) — adapters, output formats, and integration boundaries.

## For contributors

Maintainer checks and project fixture coverage are documented in the [fixture guide](docs/guard-fixtures.md)
and [release guide](docs/releasing.md).

## More from Codapult

Starting a SaaS from scratch? [Codapult](https://codapult.dev) is a production-ready Next.js SaaS
foundation built for AI-assisted development, with modular architecture, built-in AI, MCP context,
and source code under your control.

## License

MIT. See [LICENSE](LICENSE).
