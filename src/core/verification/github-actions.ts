import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { parseDocument } from 'yaml';
import type { GuardGitHubActionsPolicy } from '../guard.js';

export interface GuardCiIntegrityIssue {
  code:
    | 'workflow-unreadable'
    | 'workflow-invalid'
    | 'pull-request-trigger-missing'
    | 'pull-request-filtered'
    | 'pull-request-target-present'
    | 'job-missing'
    | 'job-conditional'
    | 'command-missing'
    | 'step-conditional'
    | 'continue-on-error'
    | 'dependency-missing'
    | 'dependency-conditional'
    | 'dependency-continue-on-error'
    | 'action-not-sha-pinned'
    | 'action-reference-changed'
    | 'base-workflow-unavailable'
    | 'permission-expansion';
  message: string;
}

export interface GuardCiIntegrityWorkflowResult {
  path: string;
  job: string;
  digest?: string | undefined;
  baseDigest?: string | undefined;
  actions: string[];
  baseActions?: string[] | undefined;
  actionChanges?: { name: string; base: string[]; current: string[] }[] | undefined;
  status: 'ok' | 'policy-weakened' | 'incomplete';
  issues: GuardCiIntegrityIssue[];
}

export interface GuardCiIntegrityResult {
  status: 'ok' | 'policy-weakened' | 'incomplete';
  workflows: GuardCiIntegrityWorkflowResult[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function getEventConfig(value: unknown, event: string): unknown {
  if (typeof value === 'string') return value === event ? null : undefined;
  if (Array.isArray(value)) return value.includes(event) ? null : undefined;
  if (isRecord(value) && Object.hasOwn(value, event)) return value[event];
  return undefined;
}

function usesFullShaPin(reference: string): boolean {
  // Local actions are mutable repository code and cannot satisfy immutable-ref
  // requirements. Protect their source paths separately when using them.
  if (reference.startsWith('./')) return false;
  const separator = reference.lastIndexOf('@');
  if (separator < 1) return false;
  return /^[a-f0-9]{40}$/i.test(reference.slice(separator + 1));
}

function parseActions(source: string): { digest: string; actions: string[] } | undefined {
  const document = parseDocument(source, { uniqueKeys: true, schema: 'core' });
  if (document.errors.length > 0) return undefined;
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 100 }) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(value) || !isRecord(value.jobs)) return undefined;
  const actions = [
    ...new Set(
      Object.values(value.jobs).flatMap((candidate) => {
        if (!isRecord(candidate)) return [];
        return [
          ...(typeof candidate.uses === 'string' ? [candidate.uses] : []),
          ...list(candidate.steps)
            .filter(isRecord)
            .flatMap((step) => (typeof step.uses === 'string' ? [step.uses] : [])),
        ];
      }),
    ),
  ].sort();
  return { digest: createHash('sha256').update(source).digest('hex'), actions };
}

function actionChanges(
  baseActions: string[],
  currentActions: string[],
): { name: string; base: string[]; current: string[] }[] {
  const byName = (actions: string[]): Map<string, string[]> => {
    const result = new Map<string, string[]>();
    for (const action of actions) {
      const at = action.lastIndexOf('@');
      const name = at > 0 ? action.slice(0, at) : action;
      result.set(name, [...(result.get(name) ?? []), action]);
    }
    return result;
  };
  const base = byName(baseActions);
  const current = byName(currentActions);
  const names = [...new Set([...base.keys(), ...current.keys()])].sort();
  return names
    .map((name) => ({
      name,
      base: [...(base.get(name) ?? [])].sort(),
      current: [...(current.get(name) ?? [])].sort(),
    }))
    .filter((change) => change.base.join('\n') !== change.current.join('\n'));
}

function isContinueOnError(value: unknown): boolean {
  if (value === true || value === 'true') return true;
  return typeof value === 'string' && value.includes('${{');
}

function analyzeWorkflow(
  root: string,
  contract: GuardGitHubActionsPolicy['workflows'][number],
  baseRef?: string,
): GuardCiIntegrityWorkflowResult {
  const absolutePath = resolve(root, contract.path);
  const relativePath = relative(resolve(root), absolutePath);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    return {
      path: contract.path,
      job: contract.job,
      status: 'incomplete',
      actions: [],
      issues: [{ code: 'workflow-unreadable', message: 'Workflow path escaped the project root.' }],
    };
  }

  let source: string;
  try {
    const realRoot = realpathSync(root);
    const realWorkflowPath = realpathSync(absolutePath);
    const resolvedRelativePath = relative(realRoot, realWorkflowPath);
    const workflowStats = lstatSync(absolutePath);
    if (
      resolvedRelativePath === '..' ||
      resolvedRelativePath.startsWith(`..${sep}`) ||
      workflowStats.isSymbolicLink() ||
      !workflowStats.isFile() ||
      workflowStats.size > 2_000_000
    ) {
      return {
        path: contract.path,
        job: contract.job,
        status: 'incomplete',
        actions: [],
        issues: [
          {
            code: 'workflow-unreadable',
            message:
              'Workflow path is symlinked, outside the project root, not a regular file, or exceeds the 2 MB limit.',
          },
        ],
      };
    }
    source = readFileSync(absolutePath, 'utf8');
  } catch {
    return {
      path: contract.path,
      job: contract.job,
      status: 'policy-weakened',
      actions: [],
      issues: [
        {
          code: 'workflow-unreadable',
          message: 'Required workflow file is missing or unreadable.',
        },
      ],
    };
  }

  const digest = createHash('sha256').update(source).digest('hex');
  let baseWorkflow: { digest: string; actions: string[] } | undefined;
  let baseWorkflowUnavailable = false;
  if (baseRef) {
    try {
      const baseSource = execFileSync('git', ['show', `${baseRef}:${contract.path}`], {
        cwd: root,
        stdio: 'pipe',
        timeout: 5_000,
        maxBuffer: 2_000_000,
      }).toString();
      baseWorkflow = parseActions(baseSource);
      baseWorkflowUnavailable = baseWorkflow === undefined;
    } catch {
      baseWorkflowUnavailable = true;
    }
  }
  const document = parseDocument(source, { uniqueKeys: true, schema: 'core' });
  if (document.errors.length > 0) {
    return {
      path: contract.path,
      job: contract.job,
      digest,
      status: 'incomplete',
      actions: [],
      issues: document.errors.map((error) => ({
        code: 'workflow-invalid',
        message: `Workflow YAML could not be parsed: ${error.message}`,
      })),
    };
  }

  let workflow: unknown;
  try {
    workflow = document.toJS({ maxAliasCount: 100 }) as unknown;
  } catch {
    return {
      path: contract.path,
      job: contract.job,
      digest,
      status: 'incomplete',
      actions: [],
      issues: [
        { code: 'workflow-invalid', message: 'Workflow YAML aliases could not be resolved.' },
      ],
    };
  }
  if (!isRecord(workflow)) {
    return {
      path: contract.path,
      job: contract.job,
      digest,
      status: 'incomplete',
      actions: [],
      issues: [{ code: 'workflow-invalid', message: 'Workflow root must be a YAML mapping.' }],
    };
  }

  const issues: GuardCiIntegrityIssue[] = [];
  if (baseWorkflowUnavailable) {
    issues.push({
      code: 'base-workflow-unavailable',
      message: 'Could not read and parse the contracted workflow from the trusted base revision.',
    });
  }
  const pullRequestEventConfig = getEventConfig(workflow.on, 'pull_request');
  const pullRequestTargetEventConfig = getEventConfig(workflow.on, 'pull_request_target');
  const pullRequestTypes = isRecord(pullRequestEventConfig)
    ? pullRequestEventConfig.types
    : undefined;
  if (contract.requirePullRequest !== false && pullRequestEventConfig === undefined) {
    issues.push({
      code: 'pull-request-trigger-missing',
      message: 'Workflow is not configured for pull_request events.',
    });
  }
  if (
    contract.requireUnfilteredPullRequest !== false &&
    isRecord(pullRequestEventConfig) &&
    (['paths', 'paths-ignore', 'branches', 'branches-ignore'].some((key) =>
      Object.hasOwn(pullRequestEventConfig, key),
    ) ||
      (Array.isArray(pullRequestTypes) &&
        ['opened', 'synchronize', 'reopened'].some((type) => !pullRequestTypes.includes(type))))
  ) {
    issues.push({
      code: 'pull-request-filtered',
      message:
        'Pull request trigger filters may prevent this workflow from running for some changes.',
    });
  }
  if (pullRequestTargetEventConfig !== undefined) {
    issues.push({
      code: 'pull-request-target-present',
      message:
        'Workflow also listens to pull_request_target; Guard cannot prove that untrusted PR content is never executed with the elevated event context.',
    });
  }

  const jobs = isRecord(workflow.jobs) ? workflow.jobs : {};
  const actions = [
    ...new Set(
      Object.values(jobs).flatMap((candidate) => {
        if (!isRecord(candidate)) return [];
        return [
          ...(typeof candidate.uses === 'string' ? [candidate.uses] : []),
          ...list(candidate.steps)
            .filter(isRecord)
            .flatMap((step) => (typeof step.uses === 'string' ? [step.uses] : [])),
        ];
      }),
    ),
  ].sort();
  const changedActionReferences = baseWorkflow ? actionChanges(baseWorkflow.actions, actions) : [];
  for (const change of changedActionReferences) {
    issues.push({
      code: 'action-reference-changed',
      message: `Action references changed for "${change.name}"; review the base and proposed refs.`,
    });
  }
  const job = jobs[contract.job];
  if (!isRecord(job)) {
    issues.push({
      code: 'job-missing',
      message: `Required workflow job "${contract.job}" is missing.`,
    });
  } else {
    if (contract.maxPermissions) {
      const permissions = isRecord(job.permissions) ? job.permissions : workflow.permissions;
      if (!isRecord(permissions)) {
        issues.push({
          code: 'permission-expansion',
          message:
            'Explicit workflow or job permissions are required by the CI integrity contract.',
        });
      } else {
        const levels = { none: 0, read: 1, write: 2 } as const;
        for (const [scope, value] of Object.entries(permissions)) {
          if (value !== 'none' && value !== 'read' && value !== 'write') {
            issues.push({
              code: 'permission-expansion',
              message: `Permission "${scope}" has an unsupported or broad value.`,
            });
            continue;
          }
          const ceiling = contract.maxPermissions[scope] ?? contract.maxPermissions['*'] ?? 'none';
          if (levels[value] > levels[ceiling]) {
            issues.push({
              code: 'permission-expansion',
              message: `Permission "${scope}: ${value}" exceeds the configured maximum "${ceiling}".`,
            });
          }
        }
      }
    }
    if (contract.requireUnconditionalJob !== false && Object.hasOwn(job, 'if')) {
      issues.push({
        code: 'job-conditional',
        message: `Required workflow job "${contract.job}" has a condition that may skip it.`,
      });
    }
    const runSteps = list(job.steps)
      .filter(isRecord)
      .filter((step) => typeof step.run === 'string');
    const commandAnchor = contract.requiredRunIncludes[0] ?? '';
    const invocationSteps = runSteps.filter(
      (step) => typeof step.run === 'string' && step.run.includes(commandAnchor),
    );
    const invocationText = invocationSteps.map((step) => step.run as string).join('\n');
    for (const fragment of contract.requiredRunIncludes) {
      if (!invocationText.includes(fragment)) {
        issues.push({
          code: 'command-missing',
          message: `Required command fragment is missing: ${fragment}`,
        });
      }
    }
    if (
      contract.requireUnconditionalJob !== false &&
      invocationSteps.some((step) => Object.hasOwn(step, 'if'))
    ) {
      issues.push({
        code: 'step-conditional',
        message: `A command step in required job "${contract.job}" has a condition that may skip it.`,
      });
    }
    if (contract.disallowContinueOnError !== false) {
      if (isContinueOnError(job['continue-on-error'])) {
        issues.push({
          code: 'continue-on-error',
          message: `Required workflow job "${contract.job}" allows errors to continue.`,
        });
      }
      for (const step of invocationSteps) {
        if (isContinueOnError(step['continue-on-error'])) {
          issues.push({
            code: 'continue-on-error',
            message: `A step in required job "${contract.job}" allows errors to continue.`,
          });
        }
      }
    }
    const needs = Array.isArray(job.needs)
      ? job.needs
      : typeof job.needs === 'string'
        ? [job.needs]
        : [];
    for (const dependency of contract.requiredNeeds ?? []) {
      if (!needs.includes(dependency)) {
        issues.push({
          code: 'dependency-missing',
          message: `Required job dependency "${dependency}" is missing from "${contract.job}".`,
        });
      }
      const dependencyJob = jobs[dependency];
      if (isRecord(dependencyJob)) {
        if (Object.hasOwn(dependencyJob, 'if')) {
          issues.push({
            code: 'dependency-conditional',
            message: `Required dependency job "${dependency}" has a condition that may skip it.`,
          });
        }
        if (isContinueOnError(dependencyJob['continue-on-error'])) {
          issues.push({
            code: 'dependency-continue-on-error',
            message: `Required dependency job "${dependency}" allows errors to continue.`,
          });
        }
      }
    }
  }

  if (contract.requireFullShaActions !== false) {
    for (const [jobId, candidate] of Object.entries(jobs)) {
      if (!isRecord(candidate)) continue;
      if (typeof candidate.uses === 'string' && !usesFullShaPin(candidate.uses)) {
        issues.push({
          code: 'action-not-sha-pinned',
          message: `Reusable workflow in job "${jobId}" is not pinned to an immutable full commit SHA.`,
        });
      }
      for (const step of list(candidate.steps).filter(isRecord)) {
        if (typeof step.uses === 'string' && !usesFullShaPin(step.uses)) {
          issues.push({
            code: 'action-not-sha-pinned',
            message: `Action "${step.uses}" in job "${jobId}" is not pinned to an immutable full commit SHA.`,
          });
        }
      }
    }
  }

  return {
    path: contract.path,
    job: contract.job,
    digest,
    ...(baseWorkflow ? { baseDigest: baseWorkflow.digest, baseActions: baseWorkflow.actions } : {}),
    actions,
    ...(baseWorkflow ? { actionChanges: changedActionReferences } : {}),
    status: baseWorkflowUnavailable ? 'incomplete' : issues.length === 0 ? 'ok' : 'policy-weakened',
    issues,
  };
}

export function auditGitHubActions(
  root: string,
  policy: GuardGitHubActionsPolicy | undefined,
  baseRef?: string,
): GuardCiIntegrityResult | undefined {
  if (!policy) return undefined;
  const workflows = policy.workflows.map((contract) => analyzeWorkflow(root, contract, baseRef));
  const status = workflows.some((workflow) => workflow.status === 'incomplete')
    ? 'incomplete'
    : workflows.some((workflow) => workflow.status === 'policy-weakened')
      ? 'policy-weakened'
      : 'ok';
  return { status, workflows };
}
