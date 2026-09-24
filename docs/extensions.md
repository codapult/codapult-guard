# Guard extensions

Guard keeps its core local, deterministic, and model-agnostic. Extensions add integration around
the core without moving source analysis or policy decisions into a remote service.

## Current extension surface

| Area                | Current support                                                                                                                                                                                 | Boundary                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| AI hosts            | Managed instructions for Codex, Cursor, Claude Code, Copilot, Gemini CLI, and generic agents; MCP tools/resources                                                                               | The host owns the LLM call, edits, and repair loop                         |
| CI/PR               | GitHub Actions template, exit codes, JSON, SARIF, PR base review packets                                                                                                                        | GitHub/GitLab owns merge protection and reviewer identity                  |
| Policy packs        | Evidence-driven packs for Next.js, React, API, database, auth, billing, jobs, AI, security, deployment, email, storage, GraphQL/RPC, i18n, observability, cache, analytics, search, and content | A detected capability is context, not an automatically blocking rule       |
| Discovery           | ts-morph AST, aliases, re-exports, dynamic imports, workspace packages, impact paths, Git history, persisted cache                                                                              | The model is a local snapshot and must be refreshed after changes          |
| External tools      | Project-owned adapters for dependency graph, security, dependency hygiene, SAST, secret scanning, and dependency audit                                                                          | Guard executes configured project scripts; it does not replace those tools |
| Approval governance | Protected mode, stale proposal checks, distinct declared approver, append-only decisions, state lock, transaction journal                                                                       | External branch protection or signed CI identity proves authorization      |
| Observability       | Run manifests, stage durations, command durations, gates, local history listing and summaries                                                                                                   | Telemetry is local by default and contains no source upload                |

## AI host workflow

Install a managed instruction block for the host that will author code:

```bash
codapult-guard install-agent codex
codapult-guard install-agent cursor
```

The host should read context, prepare a review packet, run verification, repair failures, and repeat
within the configured completion-gate limit. Guard does not invoke an LLM and does not edit source.

## CI and pull requests

Copy [`guard-ci.yml`](guard-ci.yml) into the consumer project. It runs the completion gate and exports
SARIF for GitHub Code Scanning. For PR-specific semantic context, run:

```bash
codapult-guard review --base origin/main --json > guard-review.json
```

The JSON packet can be supplied to an approved AI reviewer by the host workflow. The packet is
bounded and redacted; it is not an automatic approval.

## External tools

Configure only tools the project already owns in `.codapult/guard/agent.json`:

```json
{
  "tooling": {
    "sast": { "script": "sast", "enabled": true },
    "secret-scanning": { "script": "secrets:check", "enabled": true },
    "dependency-audit": { "script": "audit", "enabled": true }
  }
}
```

`tools: auto` discovers conventional scripts. `tools: on` makes missing configured adapters fail the
gate when `strict` verification is also enabled. The adapter output is bounded and redacted.

## Run observability

Every `verify` run records a local manifest under `.codapult/guard/history/runs/`. Consumers can use
the public API:

```ts
import { listGuardRuns, summarizeGuardRuns } from '@codapult/guard';

const recent = listGuardRuns(process.cwd(), 20);
const summary = summarizeGuardRuns(process.cwd());
```

The records expose outcome, blocking gate, stage durations, command durations, and Git commit when
available. They are intended for local diagnostics and CI artifacts, not as a hosted telemetry
service.

## What remains outside Guard

Guard does not become an IDE, PR chatbot, LLM provider, identity provider, dependency scanner, or
cloud control plane. Those are integration surfaces around the Guard facts, policy, and verification
result.
