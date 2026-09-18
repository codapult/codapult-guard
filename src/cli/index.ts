#!/usr/bin/env node

import { Command } from 'commander';
import pc from 'picocolors';
import {
  guardAnalyzeCommand,
  guardAuditCommand,
  guardBaselineCommand,
  guardCheckCommand,
  guardContractsApproveCommand,
  guardContractsRejectCommand,
  guardDoctorCommand,
  guardHistoryCommand,
  guardHistoryDiffCommand,
  guardImpactCommand,
  guardInitCommand,
  guardInstallAgentCommand,
  guardProposeCommand,
  guardReviewCommand,
  guardRulesApproveCommand,
  guardVerifyCommand,
} from './commands/guard.js';
import { config } from '../core/config.js';

const program = new Command()
  .name(config.commandName)
  .description('Local-first architecture guardrails for JavaScript and TypeScript projects')
  .configureHelp({
    styleTitle: (str) => pc.bold(pc.cyan(str)),
    styleCommandText: (str) => pc.yellow(str),
    styleOptionText: (str) => pc.green(str),
  });

// Guard is the standalone product, so its commands live at the package root:
// `codapult-guard init`, not `codapult-guard guard init`.
const guard = program;
guard.command('init').option('--force').action(guardInitCommand);
guard.command('analyze').action(guardAnalyzeCommand);
guard.command('propose').option('--json').action(guardProposeCommand);
guard.command('install-agent [target]').option('--json').action(guardInstallAgentCommand);
guard.command('doctor').option('--json').action(guardDoctorCommand);
guard.command('history').action(guardHistoryCommand);
guard.command('history-diff <from> <to>').option('--json').action(guardHistoryDiffCommand);
guard.command('impact <files...>').option('--json').action(guardImpactCommand);
guard
  .command('check')
  .option('--changed')
  .option('--json')
  .option('--sarif')
  .action(guardCheckCommand);
guard.command('audit').option('--json').action(guardAuditCommand);
guard
  .command('verify')
  .option('--checks <list>')
  .option('--tools <mode>', 'external tools: auto, on, or off', 'auto')
  .option('--strict')
  .option('--no-project-checks')
  .option('--requirement <file>')
  .option('--changed')
  .option('--json')
  .action(guardVerifyCommand);
guard
  .command('review')
  .option('--max-diff-chars <number>', undefined, '120000')
  .option('--base <ref>')
  .option('--requirement <file>')
  .action(guardReviewCommand);

const rules = guard.command('rules');
rules.command('approve [ids]').option('--all').action(guardRulesApproveCommand);
const contracts = guard.command('contracts');
contracts.command('approve [ids]').option('--all').action(guardContractsApproveCommand);
contracts.command('reject [ids]').option('--all').action(guardContractsRejectCommand);
const baseline = guard.command('baseline');
baseline
  .command('list')
  .option('--json')
  .action((options: { json?: boolean }) => guardBaselineCommand('list', undefined, options));
baseline
  .command('accept [ids]')
  .option('--all')
  .option('--reason <text>')
  .option('--json')
  .action((ids: string | undefined, options: { all?: boolean; reason?: string; json?: boolean }) =>
    guardBaselineCommand('accept', ids, options),
  );
baseline
  .command('remove [ids]')
  .option('--all')
  .option('--reason <text>')
  .option('--json')
  .action((ids: string | undefined, options: { all?: boolean; reason?: string; json?: boolean }) =>
    guardBaselineCommand('remove', ids, options),
  );

program
  .command('mcp-server')
  .description('start the Guard MCP server over stdio')
  .action(async () => {
    await import('../mcp/server.js');
  });

program.parse();
