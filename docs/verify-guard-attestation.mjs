#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const GUARD_STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
export const GUARD_PREDICATE_TYPE =
  'https://github.com/codapult/codapult-guard/blob/main/docs/attestations/guard-verification-v1.md';

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
export function validateGuardStatement(statement, { expectedHead, expectedBase }) {
  if (!isSha(expectedHead) || !isSha(expectedBase)) {
    fail('Expected head and base values must be full 40-character commit SHAs.');
  }
  if (!isRecord(statement) || statement._type !== GUARD_STATEMENT_TYPE) {
    fail(`Unsupported in-toto statement type; expected ${GUARD_STATEMENT_TYPE}.`);
  }
  if (statement.predicateType !== GUARD_PREDICATE_TYPE) {
    fail(`Unsupported Guard predicate type; expected ${GUARD_PREDICATE_TYPE}.`);
  }
  if (!Array.isArray(statement.subject) || statement.subject.length !== 1) {
    fail('Guard statement must contain exactly one subject.');
  }

  const fingerprint = statement.subject[0]?.digest?.sha256;
  const receipt = statement.predicate?.receipt;
  const scope = receipt?.verificationScope;
  if (statement.subject[0]?.name !== 'codapult-guard:verification-context') {
    fail('Guard statement subject name is invalid.');
  }
  if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) {
    fail('Guard statement subject must contain a SHA-256 digest.');
  }
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
    !isRecord(scope) ||
    scope.algorithm !== 'sha256' ||
    scope.complete !== true ||
    scope.stable !== true ||
    scope.fingerprint !== fingerprint
  ) {
    fail('Guard receipt scope is incomplete, unstable, or does not match the statement subject.');
  }
  if (
    !isSha(receipt.subject?.headSha) ||
    receipt.subject.headSha.toLowerCase() !== expectedHead.toLowerCase() ||
    !isSha(receipt.subject?.baseSha) ||
    receipt.subject.baseSha.toLowerCase() !== expectedBase.toLowerCase()
  ) {
    fail('Guard receipt does not match the expected pull request head and base SHAs.');
  }

  return {
    runId: receipt.runId,
    headSha: receipt.subject.headSha,
    baseSha: receipt.subject.baseSha,
    fingerprint,
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
