import { describe, expect, it } from 'vitest';
import {
  computeVerificationScopeFingerprint,
  isMissingVerificationScopePathError,
} from './scope.js';

describe('computeVerificationScopeFingerprint', () => {
  it('matches the published v1 known-answer vector', () => {
    expect(
      computeVerificationScopeFingerprint({
        policyFingerprint: 'a'.repeat(64),
        tool: { name: '@codapult/guard', version: '1.2.3' },
        files: [
          {
            path: 'src/deleted.ts',
            status: 'deleted',
          },
          {
            path: 'src/main.ts',
            status: 'present',
            sha256: 'c'.repeat(64),
          },
        ],
        source: {
          repository: 'example/project',
          commit: '1'.repeat(40),
          headSha: null,
          baseSha: null,
          baseCommit: null,
        },
      }),
    ).toBe('cfce79d9ad299eb4f24139bcaaac30a606a7bb672d3a026e14722bf11ce0fced');
  });

});

describe('isMissingVerificationScopePathError', () => {
  it.each(['ENOENT', 'ENOTDIR'])('recognizes %s as a missing path', (code) => {
    expect(isMissingVerificationScopePathError({ code })).toBe(true);
  });

  it.each(['EACCES', 'EIO', undefined])('does not treat %s as a missing path', (code) => {
    expect(isMissingVerificationScopePathError({ code })).toBe(false);
  });
});
