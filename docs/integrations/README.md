# AI integration kits

The examples use a project-local pnpm installation. Guard requires Node.js `>=20.19.0`; with
npm, replace `pnpm add -D @codapult/guard` with `npm install --save-dev @codapult/guard` and
replace `pnpm exec codapult-guard` with `npx --no-install codapult-guard`.

These kits keep Guard platform-neutral while giving each host a concrete setup. Each page names
the host's instruction file, MCP configuration file or command, verification command, and the
available completion hook surface.

- [Codex](codex.md)
- [Cursor](cursor.md)
- [Claude Code](claude-code.md)
- [GitHub Copilot](github-copilot.md)
- [Gemini CLI](gemini-cli.md)
- [Generic shell/CI](generic.md)

| Host               | Project instruction                | MCP setup                                              | Local completion automation           |
| ------------------ | ---------------------------------- | ------------------------------------------------------ | ------------------------------------- |
| Codex CLI          | `AGENTS.md`                        | `codex mcp add` / `~/.codex/config.toml`               | Instruction-driven; CI gate           |
| Cursor Agent       | `.cursor/rules/codapult-guard.mdc` | `.cursor/mcp.json`                                     | `.cursor/hooks.json` `stop` follow-up |
| Claude Code        | `CLAUDE.md`                        | project `.mcp.json`                                    | `.claude/settings.json` `Stop` hook   |
| Gemini CLI         | `GEMINI.md`                        | `.gemini/settings.json`                                | Instruction-driven; CI gate           |
| Copilot Chat / CLI | `.github/copilot-instructions.md`  | `.vscode/mcp.json`, `.mcp.json`, or `.github/mcp.json` | Surface-specific; CI gate             |

All integrations use the same MCP tools and completion-gate contract. None of them grants the
agent permission to edit files; that remains the user's host configuration. Guard is discoverable
in the [official MCP Registry](https://registry.modelcontextprotocol.io/?q=io.github.codapult%2Fguard)
as `io.github.codapult/guard`; Registry publication does not create one universal installer, so
follow the host-specific setup on the relevant page.

The kits are documentation-level adapters, not runtime dependencies. Install the managed
instruction for a supported host with `codapult-guard install-agent <target>`, configure the MCP
server in that host, and keep `codapult-guard verify --json` in CI as the independent gate.
