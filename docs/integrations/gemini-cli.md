# Gemini CLI integration

This page targets Gemini CLI with project settings and the project `GEMINI.md` context file.

## 1. Install Guard

Guard is published in the official MCP Registry as `io.github.codapult/guard`. Search for that identifier in a Registry-aware client and import it when the client supports Registry entries. Gemini CLI can also add the npm/stdio server directly, independently of Registry UI.

Install the package:

```bash
pnpm add -D @codapult/guard
```

If this project has not been initialized yet, establish its Guard state:

```bash
pnpm exec codapult-guard init
```

Add it to the project scope:

```bash
gemini mcp add --scope project codapult-guard pnpm exec codapult-guard mcp-server
```

The project configuration is `.gemini/settings.json`. Verify the connection inside Gemini CLI with `/mcp list` or `/mcp desc`.

## 2. Add the project instruction

Run:

```bash
pnpm exec codapult-guard install-agent gemini
```

This creates or updates the managed block in `GEMINI.md`, which Gemini CLI loads as hierarchical project context.

## 3. Completion behavior

Gemini CLI's project settings provide the MCP connection and `GEMINI.md` provides the workflow
instruction. At the end of a coding task, have the agent call `codapult_guard_next_action`, then
`codapult_guard_context`, `codapult_guard_review`, and `codapult_guard_verify`. Keep
`codapult-guard verify --json` in CI; the local agent session is not the final authority for
merging changes.

References: [Gemini CLI MCP](https://geminicli.com/docs/tools/mcp-server/), [Gemini CLI configuration](https://geminicli.com/docs/reference/configuration/), [GEMINI.md context](https://geminicli.com/docs/cli/gemini-md/).
