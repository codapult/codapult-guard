import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeGuardRun } from '../history/runs.js';
import { auditGuardGovernance } from './governance.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Guard governance audit', () => {
  it('does not create Guard state for an uninitialized project', () => {
    const root = mkdtempSync(join(tmpdir(), 'guard-governance-unconfigured-'));
    roots.push(root);

    const result = auditGuardGovernance(root);

    expect(result.configured).toBe(false);
    expect(existsSync(join(root, '.codapult'))).toBe(false);
  });

  it('counts declared actors and reports incomplete approval provenance', () => {
    const root = mkdtempSync(join(tmpdir(), 'guard-governance-'));
    roots.push(root);
    mkdirSync(join(root, '.codapult/guard'), { recursive: true });
    writeFileSync(
      join(root, '.codapult/guard/rules.json'),
      JSON.stringify({ version: 1, rules: [] }),
    );
    writeFileSync(
      join(root, '.codapult/guard/proposals.json'),
      JSON.stringify({
        version: 1,
        generatedAt: '2026-01-01T00:00:00.000Z',
        generatedBy: 'agent-a',
        proposalId: 'proposal-1',
        rules: [],
        contracts: [],
        questions: [],
        decisions: [
          {
            id: 'rule-1',
            type: 'rule',
            decision: 'approved',
            decidedAt: '2026-01-01T00:00:01.000Z',
            proposalId: 'proposal-1',
            proposalAuthor: 'agent-a',
            actor: 'agent-a',
          },
          {
            id: 'rule-2',
            decisionId: 'decision-2',
            type: 'rule',
            decision: 'approved',
            decidedAt: '2026-01-01T00:00:02.000Z',
            proposalId: 'proposal-1',
            proposalAuthor: 'agent-a',
            actor: 'reviewer-b',
            policyFingerprint: 'policy-1',
          },
        ],
      }),
    );
    writeGuardRun(root, {
      version: 1,
      runId: 'guard-governance-test',
      command: 'verify',
      startedAt: '2026-01-01T00:01:00.000Z',
      completedAt: '2026-01-01T00:01:01.000Z',
      durationMs: 1_000,
      outcome: 'pass',
      gate: 'none',
      stages: {},
      policy: {
        fingerprint: 'policy-1',
        source: 'working-tree',
        decisionIds: ['decision-2'],
      },
    });

    const result = auditGuardGovernance(root);

    expect(result).toMatchObject({
      configured: true,
      approvals: {
        total: 2,
        approved: 2,
        actors: ['agent-a', 'reviewer-b'],
        actorAuthorOverlap: ['agent-a'],
        missingCommits: 2,
      },
      reachability: {
        approvedWithPolicyFingerprint: 1,
        approvedLinkedToRun: 1,
        approvedWithoutRun: 0,
      },
    });
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('actor'),
        expect.stringContaining('policy fingerprint'),
      ]),
    );
  });

  it('does not treat a run with a different policy fingerprint as a reachable approval', () => {
    const root = mkdtempSync(join(tmpdir(), 'guard-governance-binding-'));
    roots.push(root);
    mkdirSync(join(root, '.codapult/guard'), { recursive: true });
    writeFileSync(
      join(root, '.codapult/guard/rules.json'),
      JSON.stringify({ version: 1, rules: [] }),
    );
    writeFileSync(
      join(root, '.codapult/guard/proposals.json'),
      JSON.stringify({
        version: 1,
        generatedAt: '2026-01-01T00:00:00.000Z',
        rules: [],
        contracts: [],
        questions: [],
        decisions: [
          {
            decisionId: 'decision-1',
            id: 'rule-1',
            type: 'rule',
            decision: 'approved',
            decidedAt: '2026-01-01T00:00:01.000Z',
            actor: 'reviewer',
            policyFingerprint: 'policy-approved',
          },
        ],
      }),
    );
    writeGuardRun(root, {
      version: 1,
      runId: 'guard-governance-mismatch',
      command: 'verify',
      startedAt: '2026-01-01T00:01:00.000Z',
      completedAt: '2026-01-01T00:01:01.000Z',
      durationMs: 1_000,
      outcome: 'pass',
      gate: 'none',
      stages: {},
      policy: {
        fingerprint: 'policy-other',
        source: 'working-tree',
        decisionIds: ['decision-1'],
      },
    });

    const result = auditGuardGovernance(root);

    expect(result.reachability).toMatchObject({
      approvedWithPolicyFingerprint: 1,
      approvedLinkedToRun: 0,
      approvedWithoutRun: 1,
    });
    expect(result.warnings).toContain(
      'Some approved decisions have no retained verification run linked by decision ID.',
    );
  });
});
