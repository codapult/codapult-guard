# GitHub Copilot integration

GitHub Copilot has two relevant local surfaces. Use the VS Code instructions for Copilot Chat in Agent mode, or the Copilot CLI instructions for the terminal agent. They do not share the same MCP configuration file.

## Copilot Chat in VS Code

Guard is published in the official MCP Registry as `io.github.codapult/guard`. Registry import is client-dependent; if it is not available in your VS Code MCP gallery, configure the server manually.

Install the package:

```bash
pnpm add -D @codapult/guard
```

If this project has not been initialized yet, establish its Guard state:

```bash
pnpm exec codapult-guard init
```

Create `.vscode/mcp.json`:

```json
{
  "servers": {
    "codapult-guard": {
      "type": "stdio",
      "command": "pnpm",
      "args": ["exec", "codapult-guard", "mcp-server"]
    }
  }
}
```

Start the server from `.vscode/mcp.json`, open Copilot Chat in Agent mode, and enable Guard in the tools picker. Then run:

```bash
pnpm exec codapult-guard install-agent copilot
```

This creates or updates `.github/copilot-instructions.md` with the completion workflow.

## Copilot CLI

Copilot CLI uses `~/.copilot/mcp-config.json` for persistent user servers and `.mcp.json` or `.github/mcp.json` for trusted repository/workspace servers. Add Guard to the repository:

```json
{
  "mcpServers": {
    "codapult-guard": {
      "command": "pnpm",
      "args": ["exec", "codapult-guard", "mcp-server"]
    }
  }
}
```

Place the file at `.mcp.json` or `.github/mcp.json`, then verify it with `copilot mcp list`. For one session, use `copilot --additional-mcp-config=@.mcp.json`.

The instruction file for Copilot CLI can be generated with the same command; it updates `.github/copilot-instructions.md`:

```bash
pnpm exec codapult-guard install-agent copilot
```

Keep CI as the independent final gate. Copilot's editor and CLI surfaces have different lifecycle
hooks, so this integration relies on project instructions plus `verify` rather than claiming one
universal completion hook. The instruction tells the agent to call
`codapult_guard_next_action`, `codapult_guard_context`, `codapult_guard_review`, and
`codapult_guard_verify`.

References: [Copilot MCP in VS Code](https://docs.github.com/en/copilot/how-tos/copilot-in-your-ide/customize-copilot/extend-copilot-with-tools-and-context/extend-copilot-chat-with-mcp), [Copilot CLI](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference).
