import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execSync = vi.fn();
vi.mock('node:child_process', () => ({ execSync }));

const { runProjectCommand } = await import('./command.js');

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

beforeEach(() => execSync.mockReset());

describe('runProjectCommand', () => {
  it('redacts and bounds command output', () => {
    const root = mkdtempSync(join(tmpdir(), 'codapult-command-'));
    roots.push(root);
    execSync.mockReturnValue(Buffer.from('x'.repeat(25_000)));
    const result = runProjectCommand('pnpm run test', root);

    expect(result.status).toBe('passed');
    expect(result.truncated).toBe(true);
    expect(result.stdout).toContain('[output truncated]');
  });

  it('redacts credential-shaped output', () => {
    const root = mkdtempSync(join(tmpdir(), 'codapult-command-secret-'));
    roots.push(root);
    execSync.mockReturnValue(Buffer.from('apiKey=sk_live_secret-value'));
    const result = runProjectCommand('pnpm run security', root);

    expect(result.stdout).not.toContain('sk_live_secret-value');
    expect(result.stdout).toContain('[REDACTED');
  });
});
