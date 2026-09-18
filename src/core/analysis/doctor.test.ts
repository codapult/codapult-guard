import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GUARD_DIR,
  GUARD_BASELINE_FILE,
  GUARD_CONTRACTS_FILE,
  GUARD_RULES_FILE,
} from '../guard.js';
import { diagnoseGuard } from './doctor.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('diagnoseGuard', () => {
  it('reports an uninitialized project without treating it as corrupted', () => {
    const root = mkdtempSync(join(tmpdir(), 'guard-doctor-'));
    roots.push(root);

    expect(diagnoseGuard(root).status).toBe('warning');
    expect(diagnoseGuard(root).initialized).toBe(false);
  });

  it('reports invalid initialized artifacts', () => {
    const root = mkdtempSync(join(tmpdir(), 'guard-doctor-invalid-'));
    roots.push(root);
    mkdirSync(join(root, GUARD_DIR), { recursive: true });
    writeFileSync(join(root, GUARD_BASELINE_FILE), '[]');
    writeFileSync(join(root, GUARD_RULES_FILE), '{invalid');

    const report = diagnoseGuard(root);

    expect(report.status).toBe('fail');
    expect(report.items.find((item) => item.path === GUARD_RULES_FILE)?.status).toBe('invalid');
  });

  it('validates separate contract artifacts instead of silently falling back', () => {
    const root = mkdtempSync(join(tmpdir(), 'guard-doctor-contracts-'));
    roots.push(root);
    mkdirSync(join(root, GUARD_DIR), { recursive: true });
    writeFileSync(join(root, GUARD_BASELINE_FILE), '[]');
    writeFileSync(join(root, GUARD_RULES_FILE), JSON.stringify({ version: 1, rules: [] }));
    writeFileSync(join(root, GUARD_CONTRACTS_FILE), JSON.stringify({ version: 1 }));

    const report = diagnoseGuard(root);

    expect(report.status).toBe('fail');
    expect(report.items.find((item) => item.path === GUARD_CONTRACTS_FILE)?.status).toBe('invalid');
  });
});
