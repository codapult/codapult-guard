import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const cli = resolve(process.env.GUARD_CLI ?? 'dist/cli/index.js');
const root = resolve(process.env.GUARD_FIXTURES_ROOT ?? '../guard-fixtures');
const requested = process.env.GUARD_SMOKE_PROJECTS?.split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const projects = requested?.length
  ? requested
  : ['next-learn', 'vite-react-ts-starter', 'hono-node-server', 'changesets', 'express'];

function run(project, args) {
  const outputDir = mkdtempSync(join(tmpdir(), 'guard-smoke-output-'));
  const stdoutPath = join(outputDir, 'stdout');
  const stderrPath = join(outputDir, 'stderr');
  const stdout = openSync(stdoutPath, 'w');
  const stderr = openSync(stderrPath, 'w');
  try {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: project,
      stdio: ['ignore', stdout, stderr],
      timeout: 120_000,
    });
    closeSync(stdout);
    closeSync(stderr);
    const output = readFileSync(stdoutPath, 'utf8');
    const errorOutput = readFileSync(stderrPath, 'utf8');
    if (result.status !== 0) {
      throw new Error(
        `exit ${result.status ?? 'unknown'}${result.signal ? ` (${result.signal})` : ''}: ${errorOutput.slice(0, 1000)}`,
      );
    }
    if (!output.trim()) {
      throw new Error('The CLI returned no output.');
    }
    return output;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${args.join(' ')} failed in ${project}: ${message}`, { cause: error });
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}

const results = [];
const packExpectations = {
  'next-learn': { includes: ['nextjs'], excludes: ['react'] },
  'vite-react-ts-starter': { includes: ['react'], excludes: ['nextjs', 'ai'] },
  'hono-node-server': { excludes: ['ai'] },
  express: { excludes: ['ai'] },
};
for (const name of projects) {
  const project = join(root, name);
  if (!existsSync(join(project, 'package.json'))) {
    results.push({ project: name, status: 'missing' });
    continue;
  }
  const initialized = existsSync(join(project, '.codapult/guard/baseline.json'));
  if (!initialized) run(project, ['init']);
  const doctor = JSON.parse(run(project, ['doctor', '--json']));
  const verify = JSON.parse(run(project, ['verify', '--no-project-checks', '--json']));
  const architecture = JSON.parse(
    readFileSync(join(project, '.codapult/guard/architecture.json'), 'utf8'),
  );
  const packs = (architecture.packs ?? []).map((pack) => pack.id);
  const expectation = packExpectations[name];
  const packMismatch = expectation
    ? [
        ...(expectation.includes ?? [])
          .filter((pack) => !packs.includes(pack))
          .map((pack) => `missing:${pack}`),
        ...(expectation.excludes ?? [])
          .filter((pack) => packs.includes(pack))
          .map((pack) => `unexpected:${pack}`),
      ]
    : [];
  results.push({
    project: name,
    initialized,
    doctor: doctor.status,
    verify: verify.status,
    findings: verify.architecture?.findings?.length ?? 0,
    packs,
    packMismatch,
  });
}

console.log(JSON.stringify(results, null, 2));
if (
  results.some(
    (result) =>
      result.status === 'missing' ||
      result.doctor !== 'ok' ||
      result.verify !== 'ok' ||
      result.packMismatch?.length,
  )
) {
  process.exitCode = 1;
}
