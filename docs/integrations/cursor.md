# Cursor integration

This page targets Cursor Agent in a trusted local workspace. Cursor supports project MCP
configuration in `.cursor/mcp.json`, project rules in `.cursor/rules/`, and project hooks in
`.cursor/hooks.json`.

## 1. Install Guard

Guard is listed in the official MCP Registry as `io.github.codapult/guard`. In a client that can
import Registry entries, search for that identifier and select the npm/stdio server. Cursor's
native MCP directory and one-click install are separate from the official MCP Registry; if Guard
is not offered there, use the project configuration below.

Install the package in the repository:

```bash
pnpm add -D @codapult/guard
```

If this project has not been initialized yet, establish its Guard state before enabling the hook:

```bash
pnpm exec codapult-guard init
```

Create `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "codapult-guard": {
      "type": "stdio",
      "command": "pnpm",
      "args": ["exec", "codapult-guard", "mcp-server"],
      "cwd": "${workspaceFolder}"
    }
  }
}
```

Reload Cursor and verify that `codapult-guard` appears in the MCP tools list. Keep the project
configuration in version control only if the team agrees to trust and run the local server for
every contributor.

## 2. Add the Guard rule

Run this from the project root:

```bash
pnpm exec codapult-guard install-agent cursor
```

This creates or updates `.cursor/rules/codapult-guard.mdc`. The generated rule tells Agent when
to call the MCP tools; CI remains the independent enforcement point.

## 3. Run the completion gate automatically

Cursor project hooks are command-based processes that receive JSON on stdin. Add
`.cursor/hooks/guard-stop.mjs`:

```js
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
const root = process.env.CURSOR_PROJECT_DIR ?? process.cwd();

if (input.status !== 'completed') process.exit(0);

const result = spawnSync('pnpm', ['exec', 'codapult-guard', 'verify', '--json'], {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});

if (result.status !== 0) {
  const detail = (result.stdout || result.stderr || '').trim().slice(-2_000);
  process.stdout.write(
    JSON.stringify({
      followup_message: `Guard verification failed. Fix the reported findings, then run Guard again.${detail ? `\n\n${detail}` : ''}`,
    }),
  );
}
```

Register it in `.cursor/hooks.json`:

```json
{
  "version": 1,
  "hooks": {
    "stop": [
      {
        "command": "node .cursor/hooks/guard-stop.mjs",
        "loop_limit": 3,
        "failClosed": true
      }
    ]
  }
}
```

`stop` runs when Cursor Agent is completing a task. A failed verification returns Cursor's
`followup_message`, which starts another agent iteration; `loop_limit` bounds that loop. The hook
is optional for local work; CI is the merge gate. Do not treat a hook's presence as a replacement
for CI enforcement.

## 4. Normal agent loop

Ask Cursor Agent to call `codapult_guard_next_action`, then
`codapult_guard_context`, `codapult_guard_review`, and `codapult_guard_verify`. If verification
reports an error, the agent repairs the change and repeats verification. The deterministic Guard
gate does not call an LLM.

References: [Cursor MCP](https://cursor.com/docs/mcp), [Cursor hooks](https://cursor.com/docs/hooks),
[Cursor rules](https://cursor.com/docs/context/rules).
