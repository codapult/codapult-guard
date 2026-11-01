import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readGuardGitHubContext } from './github-context.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function eventFile(payload: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), 'guard-github-event-'));
  directories.push(directory);
  const path = join(directory, 'event.json');
  writeFileSync(path, JSON.stringify(payload));
  return path;
}

describe('readGuardGitHubContext', () => {
  it('records pull request head, base, and the merge commit actually checked out', () => {
    const headSha = 'a'.repeat(40);
    const baseSha = 'b'.repeat(40);
    const mergeSha = 'c'.repeat(40);
    const path = eventFile({ pull_request: { head: { sha: headSha }, base: { sha: baseSha } } });

    expect(readGuardGitHubContext('pull_request', path, mergeSha, mergeSha)).toEqual({
      event: 'pull_request',
      headSha,
      baseSha,
      mergeSha,
    });
  });

  it('does not call a head checkout a merge commit', () => {
    const headSha = 'a'.repeat(40);
    const path = eventFile({
      pull_request: { head: { sha: headSha }, base: { sha: 'b'.repeat(40) } },
    });

    expect(readGuardGitHubContext('pull_request', path, headSha, 'c'.repeat(40))).toEqual({
      event: 'pull_request',
      headSha,
      baseSha: 'b'.repeat(40),
    });
  });

  it('reads PR SHAs from a trusted workflow_run event without inventing a merge SHA', () => {
    const headSha = 'a'.repeat(40);
    const baseSha = 'b'.repeat(40);
    const checkedOutSha = 'c'.repeat(40);
    const path = eventFile({
      workflow_run: {
        pull_requests: [{ head: { sha: headSha }, base: { sha: baseSha } }],
      },
    });

    expect(readGuardGitHubContext('workflow_run', path, checkedOutSha, 'd'.repeat(40))).toEqual({
      event: 'workflow_run',
      headSha,
      baseSha,
    });
  });

  it('records the merge-group base and exact synthetic merge SHA without inventing a PR head', () => {
    const mergeGroupSha = 'c'.repeat(40);
    const baseSha = 'b'.repeat(40);
    const path = eventFile({ merge_group: { head_sha: mergeGroupSha, base_sha: baseSha } });

    expect(readGuardGitHubContext('merge_group', path, mergeGroupSha, mergeGroupSha)).toEqual({
      event: 'merge_group',
      baseSha,
      mergeSha: mergeGroupSha,
    });
  });

  it('does not bind a merge-group receipt when the checkout differs from the requested group SHA', () => {
    const path = eventFile({ merge_group: { head_sha: 'c'.repeat(40), base_sha: 'b'.repeat(40) } });

    expect(readGuardGitHubContext('merge_group', path, 'd'.repeat(40), 'c'.repeat(40))).toEqual({
      event: 'merge_group',
      baseSha: 'b'.repeat(40),
    });
  });

  it('keeps merge-group event context but omits malformed merge-group SHAs', () => {
    const path = eventFile({ merge_group: { head_sha: 'not-a-sha', base_sha: 5 } });

    expect(readGuardGitHubContext('merge_group', path, 'c'.repeat(40), 'c'.repeat(40))).toEqual({
      event: 'merge_group',
    });
  });

  it('keeps the event name when event payload data is unavailable or malformed', () => {
    expect(
      readGuardGitHubContext('pull_request', '/missing/event.json', 'invalid', undefined),
    ).toEqual({ event: 'pull_request' });
  });

  it('omits GitHub context outside GitHub Actions', () => {
    expect(readGuardGitHubContext(undefined, undefined, undefined, undefined)).toBeUndefined();
  });
});
