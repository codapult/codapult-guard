import { readFileSync } from 'node:fs';

const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/i;

export interface GuardGitHubContext {
  event: string;
  headSha?: string | undefined;
  baseSha?: string | undefined;
  mergeSha?: string | undefined;
}

interface PullRequestEvent {
  pull_request?: {
    head?: { sha?: unknown };
    base?: { sha?: unknown };
  };
  workflow_run?: {
    pull_requests?: {
      head?: { sha?: unknown };
      base?: { sha?: unknown };
    }[];
  };
}

function validSha(value: unknown): string | undefined {
  return typeof value === 'string' && GIT_SHA_PATTERN.test(value) ? value.toLowerCase() : undefined;
}

/** Read GitHub's event payload and bind receipts to the code context actually checked out. */
export function readGuardGitHubContext(
  eventName: string | undefined,
  eventPath: string | undefined,
  checkedOutSha: string | undefined,
  eventSha: string | undefined,
): GuardGitHubContext | undefined {
  if (!eventName) return undefined;

  let payload: PullRequestEvent | undefined;
  if (
    eventPath &&
    (eventName === 'pull_request' ||
      eventName === 'pull_request_target' ||
      eventName === 'workflow_run')
  ) {
    try {
      payload = JSON.parse(readFileSync(eventPath, 'utf8')) as PullRequestEvent;
    } catch {
      // Preserve available context; missing event data is represented by absent SHAs.
    }
  }

  const pullRequest =
    payload?.pull_request ??
    (eventName === 'workflow_run' ? payload?.workflow_run?.pull_requests?.[0] : undefined);
  const headSha = validSha(pullRequest?.head?.sha);
  const baseSha = validSha(pullRequest?.base?.sha);
  const currentSha = validSha(checkedOutSha);
  const githubSha = validSha(eventSha);
  const context: GuardGitHubContext = { event: eventName };
  if (headSha) context.headSha = headSha;
  if (baseSha) context.baseSha = baseSha;
  if (
    eventName !== 'workflow_run' &&
    currentSha &&
    headSha &&
    currentSha !== headSha &&
    currentSha === githubSha
  ) {
    context.mergeSha = currentSha;
  }
  return context;
}
