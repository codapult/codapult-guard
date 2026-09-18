import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const cli = resolve(process.env.GUARD_CLI ?? 'dist/cli/index.js');
const repository = process.env.GUARD_PR_REPO;
const pullRequest = process.env.GUARD_PR_NUMBER;
const baseOverride = process.env.GUARD_PR_BASE;

if (!repository || !pullRequest) {
  throw new Error(
    'Set GUARD_PR_REPO and GUARD_PR_NUMBER, for example GUARD_PR_REPO=https://github.com/honojs/node-server GUARD_PR_NUMBER=148',
  );
}
if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?$/.test(repository))
  throw new Error(`Unsupported repository URL: ${repository}`);
if (!/^\d+$/.test(pullRequest)) throw new Error(`Invalid pull request number: ${pullRequest}`);
if (baseOverride && (!/^[\w./@-]+$/.test(baseOverride) || baseOverride.startsWith('-')))
  throw new Error(`Invalid base ref: ${baseOverride}`);
if (!existsSync(cli)) throw new Error(`Guard CLI is missing: ${cli}. Run pnpm build first.`);

const project = mkdtempSync(join(tmpdir(), 'codapult-guard-pr-'));
const runGit = (args) => execFileSync('git', args, { cwd: project, encoding: 'utf8' }).trim();
try {
  execFileSync('git', ['clone', '--filter=blob:none', '--no-checkout', repository, project], {
    stdio: 'inherit',
  });
  runGit(['fetch', 'origin', `pull/${pullRequest}/head:refs/remotes/origin/pr-${pullRequest}`]);
  const defaultBase = runGit(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).replace(
    /^origin\//,
    '',
  );
  const base = baseOverride ?? defaultBase;
  runGit(['fetch', 'origin', `${base}:refs/remotes/origin/guard-base`]);
  runGit(['checkout', `origin/pr-${pullRequest}`]);

  const init = spawnSync(process.execPath, [cli, 'init'], {
    cwd: project,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (init.status !== 0) throw new Error(`guard init failed: ${init.stderr || init.stdout}`);

  const review = spawnSync(process.execPath, [cli, 'review', '--base', 'origin/guard-base'], {
    cwd: project,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let result;
  try {
    result = JSON.parse(review.stdout);
  } catch (error) {
    throw new Error(
      `Guard returned invalid JSON (exit ${review.status}): ${review.stdout.slice(0, 500)}${review.stderr ? `\nstderr: ${review.stderr.slice(0, 1000)}` : ''}`,
      { cause: error },
    );
  }
  const changedFiles = result.changedFiles ?? [];
  if (result.diffError || review.status !== 0) {
    throw new Error(`Guard PR review failed: ${JSON.stringify(result.diffError ?? result)}`);
  }
  if (changedFiles.length === 0)
    throw new Error('The PR review produced no changed files. Check the PR ref and base.');
  console.log(
    JSON.stringify(
      {
        repository,
        pullRequest,
        base,
        changedFiles: changedFiles.length,
        status: 'ok',
        deterministicFindings: result.deterministicFindings?.length ?? 0,
        impactPaths: result.project?.insights?.impactPaths?.length ?? 0,
      },
      null,
      2,
    ),
  );
} finally {
  if (!process.env.GUARD_KEEP_PR_PROJECT) rmSync(project, { recursive: true, force: true });
  else console.error(`kept PR project: ${project}`);
}
