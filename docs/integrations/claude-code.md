# Claude Code integration

This page targets Claude Code with a project-scoped MCP server and project instructions.

## 1. Install Guard

Guard is published in the official MCP Registry as `io.github.codapult/guard`. Search for that identifier in a Registry-aware client and import the npm/stdio entry when supported. Claude Code also accepts the same server directly, so Registry discovery is optional.

Install the package:

```bash
pnpm add -D @codapult/guard
```

If this project has not been initialized yet, establish its Guard state:

```bash
pnpm exec codapult-guard init
```

Register a project-scoped stdio server:

```bash
claude mcp add --transport stdio codapult-guard --scope project \
  -- pnpm exec codapult-guard mcp-server
```

This writes the project server to `.mcp.json`. Verify it:

```bash
claude mcp get codapult-guard
claude mcp list
```

Approve the project server when Claude Code asks for workspace trust.

## 2. Add project instructions

Run:

```bash
pnpm exec codapult-guard install-agent claude
```

This creates or updates the managed block in `CLAUDE.md`. Claude Code reads that file as project instruction context; the MCP registration remains in `.mcp.json`.

## 3. Optional completion hook

Claude Code project hooks live in `.claude/settings.json`. To verify at the end of every agent
turn, create `.claude/hooks/guard-stop.sh`:

```bash
#!/usr/bin/env bash
set +e
cat >/dev/null
pnpm exec codapult-guard verify --json >&2
status=$?
if [ "$status" -ne 0 ]; then
  exit 2
fi
exit 0
```

Make it executable (`chmod +x .claude/hooks/guard-stop.sh`) and add a `Stop` command hook:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": ".claude/hooks/guard-stop.sh"
          }
        ]
      }
    ]
  }
}
```

Keep CI verification as the independent merge gate. Use `/hooks` to inspect the active hook and `/mcp` to inspect the MCP connection.

## 4. Agent loop

The agent should call `codapult_guard_next_action`, then `codapult_guard_context`,
`codapult_guard_review`, and `codapult_guard_verify`. It fixes reported errors and repeats until
the configured completion gate passes. Guard returns evidence and deterministic results; Claude
Code owns the repair loop.

References: [Claude Code MCP](https://code.claude.com/docs/en/mcp), [Claude Code hooks](https://code.claude.com/docs/en/hooks).
