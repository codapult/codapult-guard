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

## 3. Run the completion gate at the end of a turn

Codex supports project lifecycle hooks in `.codex/hooks.json`. Add a small script that runs Guard
from the repository root and feeds a failed result back to Codex. Create
`.codex/hooks/guard-stop.mjs`:

```js
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: process.cwd(),
  encoding: 'utf8',
}).trim();
const agentConfig = JSON.parse(
  readFileSync(join(root, '.codapult', 'guard', 'agent.json'), 'utf8'),
);

if (!agentConfig.completionGate?.enabled) process.exit(0);

const result = spawnSync('pnpm', ['exec', 'codapult-guard', 'verify', '--json'], {
  cwd: root,
  encoding: 'utf8',
  shell: process.platform === 'win32',
});

if (result.status === 0) process.exit(0);

const detail = (
  result.stdout ||
  result.stderr ||
  result.error?.message ||
  'Guard verification failed.'
)
  .trim()
  .slice(-3_000);
const message = `Guard verification failed. Fix the findings and run verification again.\n\n${detail}`;

if (input.stop_hook_active) {
  process.stdout.write(
    JSON.stringify({ systemMessage: `${message}\n\nAutomatic retry limit reached.` }),
  );
  process.exit(0);
}

process.stdout.write(JSON.stringify({ decision: 'block', reason: message }));
```

Register the hook in `.codex/hooks.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"$(git rev-parse --show-toplevel)/.codex/hooks/guard-stop.mjs\"",
            "commandWindows": "node (Join-Path (git rev-parse --show-toplevel).Trim() '.codex/hooks/guard-stop.mjs')",
            "statusMessage": "Verifying with Codapult Guard"
          }
        ]
      }
    ]
  }
}
```

Codex runs the hook at the end of each turn. It skips verification when
`completionGate.enabled` is `false`. On failure, `decision: "block"` asks Codex to continue with
the reported findings; if Guard still fails on that continuation, the hook reports the result and
lets the turn end. This example allows one automatic repair pass. Review and trust the project hook
in Codex with `/hooks`. Project hooks require a trusted project and run in local Codex sessions;
local command hooks are not available with cloud orchestration. Since `Stop` fires after every
turn, this also runs verification for question-only turns and can run configured project checks
repeatedly. Keep the hook optional and CI verification as the independent merge gate.

## 4. Completion workflow

Codex should call `codapult_guard_next_action`, then `codapult_guard_context`,
`codapult_guard_review`, and `codapult_guard_verify` after a coding task. It repairs errors and
repeats verification according to `.codapult/guard/agent.json`. The Stop hook allows one automatic
repair pass; the MCP workflow can continue for up to `completionGate.maxIterations`. Run the same
`codapult-guard verify --json` command in CI.

Guard does not invoke Codex or an LLM. Codex owns task execution and repairs; Guard supplies project
facts, policy evidence, and the deterministic gate.

References: [Codex hooks](https://learn.chatgpt.com/docs/hooks), [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [Codex repository instructions](https://developers.openai.com/cookbook/examples/codex/iterating-development-workflows-with-codex).
