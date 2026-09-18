import type { GuardFinding } from '../guard.js';

interface SarifResult {
  ruleId: string;
  level: 'error' | 'warning' | 'note';
  message: { text: string };
  locations: [
    { physicalLocation: { artifactLocation: { uri: string }; region: { startLine: number } } },
  ];
}

export interface SarifLog {
  version: '2.1.0';
  $schema: string;
  runs: [{ tool: { driver: { name: string; informationUri: string } }; results: SarifResult[] }];
}

export function guardFindingsToSarif(findings: GuardFinding[]): SarifLog {
  return {
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
        results: findings.map((finding) => ({
          ruleId: finding.ruleId,
          level: finding.severity === 'info' ? 'note' : finding.severity,
          message: { text: finding.message },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: finding.file },
                region: { startLine: finding.line },
              },
            },
          ],
        })),
      },
    ],
  };
}
