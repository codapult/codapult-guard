import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installGuardAgentInstructions, installGuardAgentTargets } from './agent-integration.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Guard agent integration', () => {
  it('creates a host instruction file and is idempotent', () => {
    const root = mkdtempSync(join(tmpdir(), 'guard-agent-'));
    roots.push(root);

    const first = installGuardAgentInstructions(root, 'cursor');
    const content = readFileSync(join(root, '.cursor/rules/codapult-guard.mdc'), 'utf8');
    const second = installGuardAgentInstructions(root, 'cursor');

    expect(first.action).toBe('created');
    expect(second.action).toBe('updated');
    expect(content).toContain('alwaysApply: false');
    expect(readFileSync(join(root, '.cursor/rules/codapult-guard.mdc'), 'utf8')).toBe(content);
  });

  it('preserves unrelated instructions while replacing its managed block', () => {
    const root = mkdtempSync(join(tmpdir(), 'guard-agent-preserve-'));
    roots.push(root);
    writeFileSync(join(root, 'AGENTS.md'), '# Existing instructions\n\nKeep this.\n');

    installGuardAgentInstructions(root, 'generic');
    installGuardAgentInstructions(root, 'generic');

    const content = readFileSync(join(root, 'AGENTS.md'), 'utf8');
    expect(content).toContain('# Existing instructions');
    expect(content.match(/codapult-guard:start/g)).toHaveLength(1);
    expect(content.match(/codapult-guard:end/g)).toHaveLength(1);
  });

  it('creates all selected host integrations', () => {
    const root = mkdtempSync(join(tmpdir(), 'guard-agent-all-'));
    roots.push(root);

    installGuardAgentTargets(root, ['claude', 'copilot', 'gemini']);

    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(root, '.github/copilot-instructions.md'))).toBe(true);
    expect(existsSync(join(root, 'GEMINI.md'))).toBe(true);
  });
});
