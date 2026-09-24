import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileSync = vi.fn();
vi.mock('node:child_process', () => ({ execFileSync }));

const { runProjectCommand } = await import('./command.js');

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

beforeEach(() => execFileSync.mockReset());

describe('runProjectCommand', () => {
  it('redacts and bounds command output', () => {
    const root = mkdtempSync(join(tmpdir(), 'codapult-command-'));
    roots.push(root);
    execFileSync.mockReturnValue(Buffer.from('x'.repeat(25_000)));
    const result = runProjectCommand('pnpm run test', root);

    expect(result.status).toBe('passed');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.truncated).toBe(true);
    expect(result.stdout).toContain('[output truncated]');
  });

  it('redacts credential-shaped output', () => {
    const root = mkdtempSync(join(tmpdir(), 'codapult-command-secret-'));
    roots.push(root);
    execFileSync.mockReturnValue(Buffer.from('apiKey=sk_live_secret-value'));
    const result = runProjectCommand('pnpm run security', root);

    expect(result.stdout).not.toContain('sk_live_secret-value');
    expect(result.stdout).toContain('[REDACTED');
  });

  it('rejects shell syntax instead of passing project configuration to a shell', () => {
    const root = mkdtempSync(join(tmpdir(), 'codapult-command-unsafe-'));
    roots.push(root);

    const result = runProjectCommand('pnpm run test; touch compromised', root);

    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(2);
    expect(result.durationMs).toBe(0);
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
