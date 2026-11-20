# Codex integration

This page targets Codex CLI and the Codex IDE extension. They share MCP configuration and load repository guidance from `AGENTS.md`.

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

For a team-shared project setup, create `.codex/config.toml`:

```toml
[mcp_servers.codapult-guard]
command = "pnpm"
args = ["exec", "codapult-guard", "mcp-server"]
```

Codex only loads project MCP configuration for trusted projects. Review the command and approve
the project configuration when prompted. This makes the server available to teammates using the
same project setup without writing to their user config.

For a personal setup shared across projects, register it with Codex CLI:

```bash
codex mcp add codapult-guard -- pnpm exec codapult-guard mcp-server
codex mcp list
```

This writes an entry to `~/.codex/config.toml`. The equivalent user configuration is:

```toml
[mcp_servers.codapult-guard]
command = "pnpm"
args = ["exec", "codapult-guard", "mcp-server"]
```

Use either project or user scope as appropriate. Check the connection with `codex mcp list` or
`/mcp` in the TUI. The desktop app and IDE extension share this configuration with Codex CLI.

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

References: [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [Codex repository instructions](https://developers.openai.com/cookbook/examples/codex/iterating-development-workflows-with-codex).
