import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createGuardPolicySnapshot,
  loadBaseline,
  loadGuardAgentConfig,
  loadGuardConfig,
  loadGuardProposals,
  loadGuardWaivers,
  withGuardStateLock,
  GUARD_DIR,
  type GuardProposalDecision,
} from '../guard.js';
import { GUARD_RUN_RETENTION, listGuardRuns } from '../history/runs.js';

export interface GuardGovernanceAudit {
  version: 1;
  generatedAt: string;
  configured: boolean;
  policy?:
    | {
        revision?: number | undefined;
        fingerprint: string;
      }
    | undefined;
  proposals: {
    currentId?: string | undefined;
    currentAuthor?: string | undefined;
    decisions: number;
    authors: string[];
    missingAuthors: number;
  };
  approvals: {
    total: number;
    approved: number;
    rejected: number;
    actors: string[];
    missingActors: number;
    actorAuthorOverlap: string[];
    commitAuthors: string[];
    actorCommitAuthorOverlap: string[];
    missingCommits: number;
    sources: Record<string, number>;
  };
  reachability: {
    approvedWithPolicyFingerprint: number;
    approvedLinkedToRun: number;
    approvedWithoutRun: number;
    runsWithPolicy: number;
    runsWithoutPolicy: number;
  };
  warnings: string[];
}

function commitAuthor(
  root: string,
  commit: string | undefined,
  cache: Map<string, string | undefined>,
): string | undefined {
  if (!commit || !/^[0-9a-f]{7,64}$/i.test(commit)) return undefined;
  if (cache.has(commit)) return cache.get(commit);
  try {
    const value = execFileSync('git', ['show', '-s', '--format=%ae', commit], {
      cwd: root,
      stdio: 'pipe',
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    })
      .toString()
      .trim();
    const author = value || undefined;
    cache.set(commit, author);
    return author;
  } catch {
    cache.set(commit, undefined);
    return undefined;
  }
}

function currentProposalAuthor(
  proposals: ReturnType<typeof loadGuardProposals>,
  decision: GuardProposalDecision,
): string | undefined {
  if (decision.proposalAuthor) return decision.proposalAuthor;
  if (decision.proposalId && decision.proposalId === proposals?.proposalId) {
    return proposals.generatedBy;
  }
  return undefined;
}

function auditGuardGovernanceUnlocked(root: string): GuardGovernanceAudit {
  const config = loadGuardConfig(root);
  const proposals = loadGuardProposals(root);
  const decisions = proposals?.decisions ?? [];
  const approved = decisions.filter((decision) => decision.decision === 'approved');
  const authors = [
    ...new Set(
      decisions
        .map((decision) => currentProposalAuthor(proposals, decision))
        .filter((author): author is string => Boolean(author)),
    ),
  ].sort();
  const actors = [
    ...new Set(
      approved
        .map((decision) => decision.actor?.trim())
        .filter((actor): actor is string => Boolean(actor)),
    ),
  ].sort();
  const commitAuthorCache = new Map<string, string | undefined>();
  const enrichedApprovals = approved.map((decision) => ({
    decision,
    author: currentProposalAuthor(proposals, decision),
    commitAuthor: commitAuthor(root, decision.commit, commitAuthorCache),
  }));
  const commitAuthors = [
    ...new Set(
      enrichedApprovals
        .map((item) => item.commitAuthor)
        .filter((author): author is string => Boolean(author)),
    ),
  ].sort();
  const actorAuthorOverlap = [
    ...new Set(
      enrichedApprovals
        .filter((item) => item.decision.actor && item.author && item.decision.actor === item.author)
        .map((item) => item.decision.actor)
        .filter((actor): actor is string => Boolean(actor)),
    ),
  ].sort();
  const actorCommitAuthorOverlap = [
    ...new Set(
      enrichedApprovals
        .filter((item) => item.decision.actor && item.commitAuthor === item.decision.actor)
        .map((item) => item.decision.actor)
        .filter((actor): actor is string => Boolean(actor)),
    ),
  ].sort();
  const runs = listGuardRuns(root, GUARD_RUN_RETENTION);
  const runDecisionBindings = new Map<string, Set<string>>();
  for (const run of runs) {
    const fingerprint = run.policy?.fingerprint;
    if (!fingerprint) continue;
    for (const decisionId of run.policy?.decisionIds ?? []) {
      const fingerprints = runDecisionBindings.get(decisionId) ?? new Set<string>();
      fingerprints.add(fingerprint);
      runDecisionBindings.set(decisionId, fingerprints);
    }
  }
  const approvedWithPolicyFingerprint = approved.filter(
    (decision) => decision.policyFingerprint !== undefined,
  ).length;
  const approvedLinkedToRun = approved.filter(
    (decision) =>
      decision.policyFingerprint !== undefined &&
      runDecisionBindings
        .get(
          decision.decisionId ??
            `${decision.proposalId ?? 'unknown'}:${decision.type}:${decision.id}`,
        )
        ?.has(decision.policyFingerprint),
  ).length;
  const warnings: string[] = [];
  if (approved.some((decision) => !decision.actor)) {
    warnings.push('Some approved decisions do not declare an approval actor.');
  }
  if (approved.some((decision) => !currentProposalAuthor(proposals, decision))) {
    warnings.push('Some approved decisions do not retain a proposal author.');
  }
  if (actorAuthorOverlap.length > 0) {
    warnings.push('At least one declared approval actor also authored an approved proposal.');
  }
  if (approved.some((decision) => !decision.policyFingerprint)) {
    warnings.push('Some approved decisions are not bound to a resulting policy fingerprint.');
  }
  if (
    approved.some(
      (decision) =>
        decision.policyFingerprint === undefined ||
        !runDecisionBindings
          .get(
            decision.decisionId ??
              `${decision.proposalId ?? 'unknown'}:${decision.type}:${decision.id}`,
          )
          ?.has(decision.policyFingerprint),
    )
  ) {
    warnings.push(
      'Some approved decisions have no retained verification run linked by decision ID.',
    );
  }
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    configured: config !== undefined,
    ...(config
      ? {
          policy: (() => {
            const snapshot = createGuardPolicySnapshot(
              config,
              loadBaseline(root),
              loadGuardWaivers(root),
              'working-tree',
              undefined,
              loadGuardAgentConfig(root),
            );
            return {
              ...(snapshot.revision !== undefined ? { revision: snapshot.revision } : {}),
              fingerprint: snapshot.fingerprint,
            };
          })(),
        }
      : {}),
    proposals: {
      ...(proposals?.proposalId ? { currentId: proposals.proposalId } : {}),
      ...(proposals?.generatedBy ? { currentAuthor: proposals.generatedBy } : {}),
      decisions: decisions.length,
      authors,
      missingAuthors: decisions.filter((decision) => !currentProposalAuthor(proposals, decision))
        .length,
    },
    approvals: {
      total: decisions.length,
      approved: approved.length,
      rejected: decisions.filter((decision) => decision.decision === 'rejected').length,
      actors,
      missingActors: approved.filter((decision) => !decision.actor).length,
      actorAuthorOverlap,
      commitAuthors,
      actorCommitAuthorOverlap,
      missingCommits: approved.filter((decision) => !decision.commit).length,
      sources: decisions.reduce<Record<string, number>>((counts, decision) => {
        const source = decision.source ?? 'unknown';
        counts[source] = (counts[source] ?? 0) + 1;
        return counts;
      }, {}),
    },
    reachability: {
      approvedWithPolicyFingerprint,
      approvedLinkedToRun,
      approvedWithoutRun: approvedWithPolicyFingerprint - approvedLinkedToRun,
      runsWithPolicy: runs.filter((run) => run.policy !== undefined).length,
      runsWithoutPolicy: runs.filter((run) => run.policy === undefined).length,
    },
    warnings,
  };
}

export function auditGuardGovernance(root: string): GuardGovernanceAudit {
  if (!existsSync(resolve(root, GUARD_DIR))) return auditGuardGovernanceUnlocked(root);
  return withGuardStateLock(root, () => auditGuardGovernanceUnlocked(root));
}
