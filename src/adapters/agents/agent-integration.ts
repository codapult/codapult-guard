import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type GuardAgentTarget = 'generic' | 'codex' | 'cursor' | 'claude' | 'copilot' | 'gemini';

export interface GuardAgentInstallResult {
  target: GuardAgentTarget;
  path: string;
  action: 'created' | 'updated';
}

const START_MARKER = '<!-- codapult-guard:start -->';
const END_MARKER = '<!-- codapult-guard:end -->';

const instruction = `${START_MARKER}
## Codapult Guard completion gate

After completing a coding task, read the project Guard context, review the requirement and diff,
then run Guard verification. Use the host's Guard MCP tools when available:

1. Call \`codapult_guard_context\`.
2. Call \`codapult_guard_review\` with the requirement and changed diff.
3. Call \`codapult_guard_verify\`.
4. If an error is reported, fix it and repeat steps 2–3 up to \`completionGate.maxIterations\`.
5. Report warnings and unresolved requirements; never hide them or activate proposals silently.

Guard does not edit source files or invoke an LLM. The host agent owns the repair loop. CI remains
the independent final gate.
${END_MARKER}`;

const targets: Record<GuardAgentTarget, { path: string; prefix?: string }> = {
  generic: { path: 'AGENTS.md' },
  codex: { path: 'AGENTS.md' },
  cursor: {
    path: '.cursor/rules/codapult-guard.mdc',
    prefix:
      '---\ndescription: Codapult Guard completion workflow\nalwaysApply: false\n---\n\n# Codapult Guard\n\n',
  },
  claude: { path: 'CLAUDE.md' },
  copilot: { path: '.github/copilot-instructions.md' },
  gemini: { path: 'GEMINI.md' },
};

function renderContent(target: GuardAgentTarget): string {
  return `${targets[target].prefix ?? ''}${instruction}\n`;
}

export function installGuardAgentInstructions(
  root: string,
  target: GuardAgentTarget,
): GuardAgentInstallResult {
  const relativePath = targets[target].path;
  const path = resolve(root, relativePath);
  const nextBlock = instruction;
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const start = existing.indexOf(START_MARKER);
  const end = existing.indexOf(END_MARKER);
  const content =
    start >= 0 && end >= start
      ? `${existing.slice(0, start)}${nextBlock}${existing.slice(end + END_MARKER.length)}`
      : existing.length > 0
        ? `${existing.trimEnd()}\n\n${renderContent(target)}`
        : renderContent(target);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
  return { target, path: relativePath, action: existing ? 'updated' : 'created' };
}

export function installGuardAgentTargets(
  root: string,
  targetsToInstall: GuardAgentTarget[],
): GuardAgentInstallResult[] {
  const seenPaths = new Set<string>();
  return targetsToInstall
    .filter((target) => {
      const path = targets[target].path;
      if (seenPaths.has(path)) return false;
      seenPaths.add(path);
      return true;
    })
    .map((target) => installGuardAgentInstructions(root, target));
}

export const guardAgentTargets = Object.keys(targets) as GuardAgentTarget[];
