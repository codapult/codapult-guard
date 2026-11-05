#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const GUARD_STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
export const GUARD_PREDICATE_TYPE =
  'https://github.com/codapult/codapult-guard/blob/main/docs/attestations/guard-verification-v1.md';
const GUARD_VERIFICATION_STAGES = new Set([
  'runtime',
  'project-checks',
  'adapters',
  'architecture-policy',
  'policy-surface',
  'ci-integrity',
  'verification-scope',
]);

function fail(message) {
  throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSha(value) {
  return typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);
}

/** Validate the Guard statement after its file signature and signer identity have been verified. */
export function validateGuardStatement(statement, { expectedHead, expectedBase, expectedRepository }) {
  if (!isSha(expectedHead) || !isSha(expectedBase)) {
    fail('Expected head and base values must be full 40-character commit SHAs.');
  }
  if (!isRecord(statement) || statement._type !== GUARD_STATEMENT_TYPE) {
    fail(`Unsupported in-toto statement type; expected ${GUARD_STATEMENT_TYPE}.`);
  }
  if (statement.predicateType !== GUARD_PREDICATE_TYPE) {
    fail(`Unsupported Guard predicate type; expected ${GUARD_PREDICATE_TYPE}.`);
  }
  if (!Array.isArray(statement.subject) || statement.subject.length === 0) {
    fail('Guard statement must contain its verification-context subject.');
  }

  const receipt = statement.predicate?.receipt;
  const scope = receipt?.verificationScope;
  if (!isRecord(receipt) || receipt.version !== 1 || receipt.kind !== 'verification-receipt') {
    fail('Unsupported Guard verification receipt schema.');
  }
  if (
    receipt.outcome !== 'pass' ||
    typeof receipt.runId !== 'string' ||
    receipt.runId.length === 0
  ) {
    fail('Guard receipt is not a successful verification run.');
  }
  if (
    !Array.isArray(receipt.requiredStages) ||
    receipt.requiredStages.length === 0 ||
    !receipt.requiredStages.includes('verification-scope') ||
    !Array.isArray(receipt.incompleteStages) ||
    receipt.incompleteStages.length > 0 ||
    !isRecord(receipt.stages) ||
    receipt.requiredStages.some((stage) => typeof stage !== 'string' || stage.length === 0) ||
    new Set(receipt.requiredStages).size !== receipt.requiredStages.length ||
    receipt.requiredStages.some((stage) => !GUARD_VERIFICATION_STAGES.has(stage)) ||
    receipt.requiredStages.some((stage) => receipt.stages[stage] !== 'ok')
  ) {
    fail('Guard receipt has incomplete required verification stages.');
  }
  if (
    !isRecord(scope) ||
    scope.algorithm !== 'sha256' ||
    scope.complete !== true ||
    scope.stable !== true ||
    !isRecord(scope.source) ||
    !/^[a-f0-9]{40}$/.test(scope.source.commit ?? '') ||
    !/^[a-f0-9]{64}$/.test(scope.fingerprint ?? '') ||
    !Array.isArray(scope.files) ||
    !isRecord(receipt.policy) ||
    !/^[a-f0-9]{64}$/.test(receipt.policy.fingerprint ?? '') ||
    !isRecord(receipt.tool) ||
    receipt.tool.name !== '@codapult/guard' ||
    typeof receipt.tool.version !== 'string' ||
    receipt.tool.version.length === 0
  ) {
    fail('Guard receipt scope is incomplete, unstable, or has unsupported fingerprint inputs.');
  }
  if (
    scope.source.commit !== expectedHead ||
    scope.source.headSha !== expectedHead ||
    scope.source.baseSha !== expectedBase ||
    scope.source.baseCommit !== expectedBase ||
    (expectedRepository !== undefined &&
      (typeof scope.source.repository !== 'string' ||
        scope.source.repository.toLowerCase() !== expectedRepository.toLowerCase()))
  ) {
    fail('Guard scope is not bound to the expected repository and head/base revisions.');
  }

  const expectedFingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        algorithm: 'sha256',
        policyFingerprint: receipt.policy.fingerprint,
        tool: { name: receipt.tool.name, version: receipt.tool.version },
        files: scope.files.map((file) =>
          file.status === 'present'
            ? { path: file.path, status: file.status, sha256: file.sha256 }
            : { path: file.path, status: file.status },
        ),
        source: {
          repository: scope.source.repository,
          commit: scope.source.commit,
          headSha: scope.source.headSha,
          baseSha: scope.source.baseSha,
          baseCommit: scope.source.baseCommit,
        },
      }),
      'utf8',
    )
    .digest('hex');
  if (scope.fingerprint !== expectedFingerprint) {
    fail(
      'Guard verification-scope fingerprint does not match its policy, tool, and file inventory.',
    );
  }

  const expectedSubjects = [
    { name: 'codapult-guard:verification-context', sha256: scope.fingerprint },
  ];
  let previousPath;
  for (const file of scope.files) {
    if (
      !isRecord(file) ||
      typeof file.path !== 'string' ||
      file.path.length === 0 ||
      file.path.includes('\\') ||
      file.path.startsWith('/') ||
      /^[a-z]:\//i.test(file.path) ||
      file.path.split('/').includes('..') ||
      !['present', 'deleted'].includes(file.status) ||
      (file.status === 'present'
        ? typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)
        : file.sha256 !== undefined)
    ) {
      fail('Guard receipt contains an invalid file digest or status in a complete scope.');
    }
    if (previousPath !== undefined && file.path <= previousPath) {
      fail('Guard receipt scope files are not uniquely sorted by path.');
    }
    previousPath = file.path;
    if (file.status === 'present') {
      expectedSubjects.push({ name: `file:${file.path}`, sha256: file.sha256 });
    }
  }
  if (statement.subject.length !== expectedSubjects.length) {
    fail('Guard statement subjects do not match the verification scope.');
  }
  for (const [index, expected] of expectedSubjects.entries()) {
    const actual = statement.subject[index];
    if (actual?.name !== expected.name || actual?.digest?.sha256 !== expected.sha256) {
      fail('Guard statement subjects do not match the verification scope.');
    }
  }
  if (
    (receipt.subject?.repository ?? null) !== scope.source.repository ||
    receipt.subject?.commit !== scope.source.commit ||
    !isSha(receipt.subject?.headSha) ||
    receipt.subject.headSha.toLowerCase() !== expectedHead.toLowerCase() ||
    !isSha(receipt.subject?.baseSha) ||
    receipt.subject.baseSha.toLowerCase() !== expectedBase.toLowerCase() ||
    receipt.subject.headSha !== scope.source.headSha ||
    receipt.subject.baseSha !== scope.source.baseSha ||
    receipt.subject.baseCommit !== scope.source.baseCommit
  ) {
    fail('Guard receipt does not match the expected pull request head and base SHAs.');
  }

  return {
    runId: receipt.runId,
    headSha: receipt.subject.headSha,
    baseSha: receipt.subject.baseSha,
    fingerprint: scope.fingerprint,
  };
}

function parseArgs(args) {
  const [statementPath, ...options] = args;
  const values = new Map();
  for (let index = 0; index < options.length; index += 2) {
    const key = options[index];
    const value = options[index + 1];
    if (!key?.startsWith('--') || !value || values.has(key)) {
      fail('Invalid or duplicate command-line option.');
    }
    values.set(key, value);
  }

  const required = [
    '--repo',
    '--signer-workflow',
    '--source-ref',
    '--expected-head',
    '--expected-base',
  ];
  if (
    !statementPath ||
    required.some((key) => !values.has(key)) ||
    values.size !== required.length
  ) {
    fail(
      'Usage: node verify-guard-attestation.mjs <statement.json> --repo ORG/REPO --signer-workflow ORG/REPO/.github/workflows/FILE.yml --source-ref refs/heads/main --expected-head SHA --expected-base SHA',
    );
  }
  return { statementPath, values };
}

export function verifyWithGitHub(
  statementPath,
  { repo, signerWorkflow, sourceRef },
  run = spawnSync,
) {
  const args = [
    'attestation',
    'verify',
    statementPath,
    '--repo',
    repo,
    '--signer-workflow',
    signerWorkflow,
    '--source-ref',
    sourceRef,
    '--format=json',
  ];
  const result = run('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error) fail(`Could not run GitHub CLI: ${result.error.message}`);
  if (result.status !== 0) {
    fail(
      `GitHub attestation verification failed: ${(result.stderr || result.stdout || '').trim()}`,
    );
  }
}

export function main(args = process.argv.slice(2), run = spawnSync) {
  const { statementPath, values } = parseArgs(args);
  const repo = values.get('--repo');
  const signerWorkflow = values.get('--signer-workflow');
  const sourceRef = values.get('--source-ref');
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) fail('--repo must use ORG/REPO format.');
  if (!signerWorkflow || !sourceRef) fail('Signer workflow and source ref must be nonempty.');

  verifyWithGitHub(statementPath, { repo, signerWorkflow, sourceRef }, run);
  const statement = JSON.parse(readFileSync(statementPath, 'utf8'));
  const receipt = validateGuardStatement(statement, {
    expectedHead: values.get('--expected-head'),
    expectedBase: values.get('--expected-base'),
    expectedRepository: repo,
  });
  process.stdout.write(
    `Verified Guard receipt ${receipt.runId}: head ${receipt.headSha}, base ${receipt.baseSha}, scope sha256:${receipt.fingerprint}\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
