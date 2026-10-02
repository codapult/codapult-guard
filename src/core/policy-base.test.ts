import { afterEach, describe, expect, it, vi } from 'vitest';

const gitShow = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ execFileSync: gitShow }));

const { loadGuardPolicyAtRevision } = await import('./guard.js');

afterEach(() => {
  gitShow.mockReset();
});

describe('Guard policy base snapshots', () => {
  it('loads policy artifacts from a Git ref and includes baseline state', () => {
    gitShow.mockImplementation((_command: string, args: string[]) => {
      const target = args[1] ?? '';
      if (target.endsWith(':.codapult/guard/rules.json')) {
        return Buffer.from(
          JSON.stringify({
            version: 1,
            revision: 17,
            rules: [],
          }),
        );
      }
      if (target.endsWith(':.codapult/guard/baseline.json')) {
        return Buffer.from(JSON.stringify(['legacy-finding']));
      }
      if (target.endsWith(':.codapult/guard/waivers.json')) {
        return Buffer.from(JSON.stringify({ version: 1, waivers: [], decisions: [] }));
      }
      if (target.endsWith(':.codapult/guard/agent.json')) {
        return Buffer.from(
          JSON.stringify({
            version: 1,
            tools: 'off',
            tooling: {},
            completionGate: {
              enabled: true,
              maxIterations: 3,
              projectChecks: true,
              checks: ['typecheck'],
            },
          }),
        );
      }
      throw new Error('missing policy artifact');
    });

    const snapshot = loadGuardPolicyAtRevision('/project', 'origin/main');

    expect(snapshot).toMatchObject({
      revision: 17,
      source: 'git-ref',
      ref: 'origin/main',
      baseline: new Set(['legacy-finding']),
    });
    expect(snapshot?.fingerprint).toHaveLength(64);
  });

  it('rejects unsafe refs before invoking Git', () => {
    expect(() => loadGuardPolicyAtRevision('/project', '--upload-pack=evil')).toThrow(
      'unsafe policy ref',
    );
    expect(gitShow).not.toHaveBeenCalled();
  });

  it('rejects a malformed baseline from the base ref instead of silently filtering it', () => {
    gitShow.mockImplementation((_command: string, args: string[]) => {
      const target = args[1] ?? '';
      if (target.endsWith(':.codapult/guard/rules.json')) {
        return Buffer.from(JSON.stringify({ version: 1, rules: [] }));
      }
      if (target.endsWith(':.codapult/guard/baseline.json')) {
        return Buffer.from(JSON.stringify(['valid', 42]));
      }
      throw new Error('missing policy artifact');
    });

    expect(() => loadGuardPolicyAtRevision('/project', 'origin/main')).toThrow(
      '.codapult/guard/baseline.json',
    );
  });
});
