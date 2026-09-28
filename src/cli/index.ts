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
  guardPolicyExplainCommand,
  guardProposeCommand,
  guardReviewCommand,
  guardRunsCommand,
  guardRulesApproveCommand,
  guardVerifyCommand,
  guardWaiverCommand,
  type GuardWaiverOptions,
} from './commands/guard.js';
import { config } from '../core/config.js';
import {
  GuardBaselineReasonError,
  GuardConfigError,
  GuardStateBusyError,
  GuardStateStaleError,
  GuardWaiverError,
} from '../core/guard.js';
import { guardErrorPayload } from '../core/errors.js';

interface GuardOutputOptions {
  json?: boolean | undefined;
}

interface BaselineCommandOptions {
  all?: boolean | undefined;
  reason?: string | undefined;
  json?: boolean | undefined;
}

interface BaselineListOptions {
  json?: boolean | undefined;
}

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
guard.command('init').option('--force').option('--no-wait').action(guardInitCommand);
guard.command('analyze').option('--refresh').option('--no-wait').action(guardAnalyzeCommand);
guard.command('propose').option('--json').action(guardProposeCommand);
guard.command('install-agent [target]').option('--json').action(guardInstallAgentCommand);
guard.command('doctor').option('--json').option('--fix-cache').action(guardDoctorCommand);
guard.command('history').action(guardHistoryCommand);
guard.command('runs').option('--json').action(guardRunsCommand);
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
const policy = guard.command('policy');
policy.command('explain <id>').option('--json').action(guardPolicyExplainCommand);
const contracts = guard.command('contracts');
contracts.command('approve [ids]').option('--all').action(guardContractsApproveCommand);
contracts.command('reject [ids]').option('--all').action(guardContractsRejectCommand);
const baseline = guard.command('baseline');
baseline
  .command('list')
  .option('--json')
  .action((options: BaselineListOptions) => guardBaselineCommand('list', undefined, options));
baseline
  .command('accept [ids]')
  .option('--all')
  .option('--reason <text>')
  .option('--json')
  .action((ids: string | undefined, options: BaselineCommandOptions) =>
    guardBaselineCommand('accept', ids, options),
  );
baseline
  .command('remove [ids]')
  .option('--all')
  .option('--reason <text>')
  .option('--json')
  .action((ids: string | undefined, options: BaselineCommandOptions) =>
    guardBaselineCommand('remove', ids, options),
  );

const waivers = guard.command('waiver');
waivers
  .command('list')
  .option('--json')
  .action((options: GuardOutputOptions) => guardWaiverCommand('list', undefined, options));
waivers
  .command('add <fingerprint>')
  .requiredOption('--owner <owner>')
  .requiredOption('--reason <text>')
  .requiredOption('--expires <date>')
  .option('--issue <url>')
  .option('--json')
  .action((fingerprint: string, options: GuardWaiverOptions) =>
    guardWaiverCommand('add', fingerprint, options),
  );
waivers
  .command('remove <id>')
  .requiredOption('--reason <text>')
  .option('--json')
  .action((id: string, options: GuardWaiverOptions) => guardWaiverCommand('remove', id, options));
waivers
  .command('renew <id>')
  .requiredOption('--expires <date>')
  .requiredOption('--reason <text>')
  .option('--json')
  .action((id: string, options: GuardWaiverOptions) => guardWaiverCommand('renew', id, options));

program
  .command('mcp-server')
  .description('start the Guard MCP server over stdio')
  .action(async () => {
    await import('../mcp/server.js');
  });

try {
  program.parse();
} catch (error) {
  if (
    error instanceof GuardConfigError ||
    error instanceof GuardBaselineReasonError ||
    error instanceof GuardStateBusyError ||
    error instanceof GuardStateStaleError ||
    error instanceof GuardWaiverError
  ) {
    const isBusy = error instanceof GuardStateBusyError;
    const isStale = error instanceof GuardStateStaleError;
    const isInvalidInput = error instanceof GuardBaselineReasonError;
    console.error(
      JSON.stringify(
        guardErrorPayload(
          isBusy
            ? 'GUARD_STATE_BUSY'
            : isStale
              ? 'GUARD_STATE_STALE'
              : isInvalidInput
                ? 'GUARD_INVALID_INPUT'
                : 'GUARD_CONFIG_INVALID',
          error.message,
          {
            configured: !isBusy && !isStale,
            outcome: 'error',
            recoverable: true,
            hint:
              isBusy || isStale
                ? 'Re-read Guard state and retry the operation.'
                : isInvalidInput
                  ? 'Provide a written reason for the baseline decision.'
                  : 'Repair the invalid Guard artifact, then run codapult-guard doctor.',
          },
        ),
        null,
        2,
      ),
    );
    process.exitCode = 1;
  } else {
    throw error;
  }
}
