import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  GUARD_AGENT_FILE,
  GUARD_BASELINE_META_FILE,
  GUARD_ARCHITECTURE_FILE,
  GUARD_BASELINE_FILE,
  GUARD_CONVENTIONS_FILE,
  GUARD_CONTRACTS_FILE,
  GUARD_PROPOSALS_FILE,
  GUARD_PROJECT_FILE,
  GUARD_RULES_FILE,
  loadGuardConfig,
  loadProjectModel,
  isGuardAgentConfig,
  isGuardContractsFile,
  isGuardProposalFile,
  validateGuardContracts,
} from '../guard.js';

export interface GuardDoctorItem {
  path: string;
  status: 'ok' | 'missing' | 'invalid';
  message: string;
}

export interface GuardDoctorReport {
  status: 'ok' | 'warning' | 'fail';
  initialized: boolean;
  items: GuardDoctorItem[];
  recommendation?: string;
}

const requiredArtifacts = [
  GUARD_BASELINE_FILE,
  GUARD_RULES_FILE,
  GUARD_PROJECT_FILE,
  GUARD_ARCHITECTURE_FILE,
  GUARD_CONVENTIONS_FILE,
  GUARD_AGENT_FILE,
  GUARD_CONTRACTS_FILE,
  GUARD_PROPOSALS_FILE,
] as const;

function parseJson(root: string, path: string): unknown {
  try {
    return JSON.parse(readFileSync(resolve(root, path), 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

export function diagnoseGuard(root: string): GuardDoctorReport {
  const initialized = existsSync(resolve(root, GUARD_BASELINE_FILE));
  const items: GuardDoctorItem[] = requiredArtifacts.map((path) => {
    const guardConfig = path === GUARD_CONTRACTS_FILE ? loadGuardConfig(root) : undefined;
    if (!existsSync(resolve(root, path))) {
      return { path, status: 'missing', message: 'Artifact is missing.' };
    }
    if (path === GUARD_RULES_FILE && !loadGuardConfig(root)) {
      return { path, status: 'invalid', message: 'Guard rules are invalid or unsupported.' };
    }
    if (path === GUARD_PROJECT_FILE && !loadProjectModel(root)) {
      return { path, status: 'invalid', message: 'Project model is invalid or unsupported.' };
    }
    if (path === GUARD_AGENT_FILE && !isGuardAgentConfig(parseJson(root, path))) {
      return { path, status: 'invalid', message: 'Agent policy is invalid or unsupported.' };
    }
    if (path === GUARD_CONTRACTS_FILE && !isGuardContractsFile(parseJson(root, path))) {
      return { path, status: 'invalid', message: 'Guard contracts are invalid or unsupported.' };
    }
    if (
      path === GUARD_CONTRACTS_FILE &&
      guardConfig &&
      validateGuardContracts(root, guardConfig.contracts).length > 0
    ) {
      return { path, status: 'invalid', message: 'Guard contract scopes or references are stale.' };
    }
    if (path === GUARD_PROPOSALS_FILE && !isGuardProposalFile(parseJson(root, path))) {
      return { path, status: 'invalid', message: 'Guard proposals are invalid or unsupported.' };
    }
    if (parseJson(root, path) === undefined) {
      return { path, status: 'invalid', message: 'Artifact is invalid JSON.' };
    }
    return { path, status: 'ok', message: 'Artifact is present and readable.' };
  });
  if (initialized && existsSync(resolve(root, GUARD_BASELINE_META_FILE))) {
    const metadata = parseJson(root, GUARD_BASELINE_META_FILE);
    items.push({
      path: GUARD_BASELINE_META_FILE,
      status:
        metadata !== undefined &&
        metadata !== null &&
        typeof metadata === 'object' &&
        (metadata as { version?: unknown }).version === 1
          ? 'ok'
          : 'invalid',
      message: 'Baseline metadata is present and readable.',
    });
  }
  const missing = items.filter((item) => item.status === 'missing');
  const invalid = items.filter((item) => item.status === 'invalid');
  return {
    status:
      invalid.length > 0 || (initialized && missing.length > 0)
        ? 'fail'
        : missing.length > 0
          ? 'warning'
          : 'ok',
    initialized,
    items,
    ...(invalid.length > 0
      ? {
          recommendation: 'Run `codapult-guard init --force` after reviewing the current baseline.',
        }
      : missing.length > 0
        ? { recommendation: 'Run `codapult-guard analyze` or reinitialize Guard intentionally.' }
        : {}),
  };
}
