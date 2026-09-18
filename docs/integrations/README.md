# AI integration kits

These kits keep Guard platform-neutral while giving each host a copyable setup. The exact hook
configuration is owned by the AI client and can change independently from Guard.

- [Codex](codex.md)
- [Cursor](cursor.md)
- [Claude Code](claude-code.md)
- [GitHub Copilot](github-copilot.md)
- [Gemini CLI](gemini-cli.md)
- [Generic shell/CI](generic.md)

All integrations use the same MCP tools and completion-gate contract. None of them grants the
agent permission to edit files; that remains the user's host configuration.

The kits are intentionally documentation-level adapters, not runtime dependencies. Install the
managed instruction for a supported host with `codapult-guard install-agent <target>`; configure
the MCP server in that host separately. This keeps Guard independent from host-specific hook
syntax and version changes.
