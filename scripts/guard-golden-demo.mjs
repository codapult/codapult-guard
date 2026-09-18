import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const cli = resolve(process.env.GUARD_CLI ?? 'dist/cli/index.js');
const source = resolve(process.env.GUARD_GOLDEN_ROOT ?? '../codapult');
const project = mkdtempSync(join(tmpdir(), 'codapult-guard-golden-'));

function run(args) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: project,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 120_000,
    maxBuffer: 10_000_000,
  });
}

function runAllowFailure(args) {
  try {
    return { status: 0, stdout: run(args), stderr: '' };
  } catch (error) {
    return {
      status: error.status ?? 1,
      stdout: error.stdout?.toString() ?? '',
      stderr: `${error.stderr?.toString() ?? ''}${error.message ? ` ${error.message}` : ''}`,
    };
  }
}

try {
  if (!existsSync(join(source, 'package.json'))) throw new Error(`Project is missing: ${source}`);
  cpSync(source, project, {
    recursive: true,
    filter: (path) => !/(?:\/|^)(?:node_modules|\.next|\.codapult)(?:\/|$)/.test(path),
  });
  run(['init']);

  const rulesPath = join(project, '.codapult/guard/rules.json');
  const rules = JSON.parse(readFileSync(rulesPath, 'utf8'));
  rules.rules.push({
    id: 'golden-no-server-import',
    description: 'Golden demo forbids the server-only module in a client entrypoint.',
    severity: 'error',
    kind: 'forbidden-import',
    patterns: ['./server-only'],
    files: ['guard-golden-client.ts'],
    status: 'active',
  });
  writeFileSync(rulesPath, `${JSON.stringify(rules, null, 2)}\n`);
  writeFileSync(join(project, 'guard-golden-client.ts'), "import './server-only';\n");
  writeFileSync(join(project, 'server-only.ts'), 'export const serverOnly = true;\n');

  const failedCheck = runAllowFailure(['check', '--changed', '--json']);
  if (!failedCheck.stdout) {
    throw new Error(
      `Golden check produced no JSON (status ${failedCheck.status}, signal ${failedCheck.signal}): ${failedCheck.stderr}`,
    );
  }
  const failedReport = JSON.parse(failedCheck.stdout);
  if (
    failedCheck.status === 0 ||
    !failedReport.report.findings.some((finding) => finding.ruleId === 'golden-no-server-import')
  ) {
    throw new Error('Guard did not detect the intentional golden-demo violation.');
  }

  writeFileSync(join(project, 'guard-golden-client.ts'), 'export const client = true;\n');
  const passedCheck = JSON.parse(run(['check', '--changed', '--json']));
  const review = JSON.parse(run(['review']));
  const verify = JSON.parse(run(['verify', '--no-project-checks', '--json']));
  if (
    passedCheck.outcome !== 'pass' ||
    review.changedFiles.length === 0 ||
    verify.outcome !== 'pass'
  ) {
    throw new Error('Guard golden path did not recover after the repair.');
  }
  console.log(
    JSON.stringify(
      {
        checkAfterRepair: passedCheck.outcome,
        reviewedFiles: review.changedFiles.length,
        verify: verify.outcome,
      },
      null,
      2,
    ),
  );
} finally {
  if (!process.env.GUARD_KEEP_GOLDEN_PROJECT) rmSync(project, { recursive: true, force: true });
  else console.error(`kept golden project: ${project}`);
}
