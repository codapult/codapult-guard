# Codex integration

This page targets Codex CLI and Codex-compatible IDE integrations that read `AGENTS.md` and support the Codex MCP configuration.

## 1. Install Guard

Guard is published in the official MCP Registry as `io.github.codapult/guard`. Use the Registry entry when a Codex host offers Registry import. Otherwise configure the npm/stdio server directly; the Registry is discovery and does not replace the host's MCP configuration.

Install the package:

```bash
pnpm add -D @codapult/guard
```

If this project has not been initialized yet, establish its Guard state:

```bash
pnpm exec codapult-guard init
```

Register the server with Codex CLI:

```bash
codex mcp add codapult-guard -- pnpm exec codapult-guard mcp-server
codex mcp list
```

The equivalent user configuration is an entry in `~/.codex/config.toml`:

```toml
[mcp_servers.codapult-guard]
command = "pnpm"
args = ["exec", "codapult-guard", "mcp-server"]
```

Codex stores this MCP registration in its user configuration. Keep the repository's `AGENTS.md`
and CI gate in version control; configure the MCP server separately on each developer machine.

## 2. Add repository instructions

Run:

```bash
pnpm exec codapult-guard install-agent codex
```

This creates or updates the managed Guard block in `AGENTS.md`. Codex loads `AGENTS.md` as repository instruction context, while the MCP server remains a separate tool configuration.

## 3. Completion workflow

Codex should call `codapult_guard_next_action`, then `codapult_guard_context`,
`codapult_guard_review`, and `codapult_guard_verify` after a coding task. It repairs errors and
repeats verification according to `.codapult/guard/agent.json`. Run the same
`codapult-guard verify --json` command in CI.

Guard does not invoke Codex or an LLM. Codex owns task execution and repairs; Guard supplies project facts, policy evidence, and the deterministic gate.

References: [Codex MCP configuration example](https://developers.openai.com/learn/docs-mcp), [Codex repository instructions](https://developers.openai.com/cookbook/examples/codex/code_modernization).
