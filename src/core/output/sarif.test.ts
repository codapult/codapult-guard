import { describe, expect, it } from 'vitest';
import { guardFindingsToSarif } from './sarif.js';

describe('guardFindingsToSarif', () => {
  it('emits GitHub-compatible SARIF locations and levels', () => {
    const sarif = guardFindingsToSarif([
      {
        ruleId: 'client-no-db',
        severity: 'error',
        file: 'src/client.ts',
        line: 7,
        importPath: '@/lib/db',
        message: 'Client code must not import the database.',
        fingerprint: 'fingerprint',
      },
    ]);

    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0].results[0]).toMatchObject({
      ruleId: 'client-no-db',
      level: 'error',
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: 'src/client.ts' },
            region: { startLine: 7 },
          },
        },
      ],
    });
  });
});
