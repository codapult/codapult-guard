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

    expect(JSON.stringify(sarif)).toBe(
      JSON.stringify({
        version: '2.1.0',
        $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
        runs: [
          {
            tool: {
              driver: {
                name: 'Codapult Guard',
                informationUri: 'https://codapult.dev/docs/developer-tools/guard',
              },
            },
            results: [
              {
                ruleId: 'client-no-db',
                level: 'error',
                message: { text: 'Client code must not import the database.' },
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: { uri: 'src/client.ts' },
                      region: { startLine: 7 },
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
  });

  it('emits location-free operational notices', () => {
    const sarif = guardFindingsToSarif(
      [],
      [
        {
          ruleId: 'guard-waiver-expiring',
          level: 'warning',
          message: 'Waiver expires soon.',
        },
      ],
    );

    expect(sarif.runs[0].results).toEqual([
      {
        ruleId: 'guard-waiver-expiring',
        level: 'warning',
        message: { text: 'Waiver expires soon.' },
      },
    ]);
  });
});
