import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import {
  GUARD_BASELINE_FILE,
  GUARD_BASELINE_META_FILE,
  GUARD_ARCHITECTURE_FILE,
  GUARD_CONVENTIONS_FILE,
  GUARD_AGENT_FILE,
  GUARD_CONTRACTS_FILE,
  GUARD_PROPOSALS_FILE,
  GUARD_PROJECT_FILE,
  GUARD_HISTORY_DIR,
  GUARD_RULES_FILE,
  findGuardRoot,
  discoverProjectWithMetrics,
  buildGuardReviewPacket,
  buildGuardProposals,
  buildGeneratedGuardConfig,
  discoverProject,
  GuardAlreadyInitializedError,
  initializeGuard,
  loadBaseline,
  updateBaseline,
  loadGuardConfig,
  loadGuardProposals,
  writeGuardConfig,
  writeGuardProposals,
  recordGuardProposalDecision,
  getGuardProposalFreshness,
  scanGuard,
  classifyGuardOutcome,
  validateGuardContracts,
  writeProjectModel,
  writeGuardMemory,
  writeProjectSnapshot,
  type GuardToolMode,
  type GuardFinding,
} from '../../core/guard.js';
import {
  runGuardVerification,
  type GuardVerificationCheck,
} from '../../core/verification/verify.js';
import { diagnoseGuard } from '../../core/analysis/doctor.js';
import { diffGuardSnapshots, listGuardSnapshots } from '../../core/history/history.js';
import {
  guardAgentTargets,
  installGuardAgentInstructions,
  installGuardAgentTargets,
  type GuardAgentTarget,
} from '../../adapters/agents/agent-integration.js';
import { dim, fail, heading, info, success, warn } from '../ui.js';
import { guardFindingsToSarif } from '../../core/output/sarif.js';

function renderFindings(findings: ReturnType<typeof scanGuard>['findings']): void {
  for (const finding of findings) {
    const printer =
      finding.severity === 'error' ? fail : finding.severity === 'warning' ? warn : info;
    printer(`${finding.file}:${finding.line} [${finding.ruleId}] ${finding.message}`);
    dim(`  import: ${finding.importPath}`);
  }
}

function getRoot(): string {
  return findGuardRoot();
}

function readRequirement(root: string, file?: string): string | undefined {
  if (!file) return undefined;
  const path = resolve(root, file);
  const relativePath = relative(root, path);
  if (relativePath.split(/[\\/]/).includes('..')) {
    fail(`--requirement ${file}: file must be inside the project root`);
    process.exitCode = 1;
    return undefined;
  }
  try {
    const value = readFileSync(path, 'utf8').trim();
    if (!value) throw new Error('file is empty');
    if (value.length > 20_000) throw new Error('file exceeds the 20,000 character limit');
    return value;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'cannot read file';
    fail(`--requirement ${file}: ${message}`);
    process.exitCode = 1;
    return undefined;
  }
}

export function guardInitCommand(options: { force?: boolean } = {}): void {
  const root = getRoot();
  let initialized: ReturnType<typeof initializeGuard>;
  try {
    initialized = initializeGuard(root, { force: options.force });
  } catch (error) {
    if (error instanceof GuardAlreadyInitializedError) {
      fail(`${error.message} Use \`codapult-guard init --force\` to replace it.`);
    } else {
      fail(error instanceof Error ? error.message : 'Guard initialization failed.');
    }
    process.exitCode = 1;
    return;
  }
  const { config, report } = initialized;
  heading('Codapult Guard Init');
  success(`Created ${GUARD_RULES_FILE}`);
  success(`Created ${GUARD_ARCHITECTURE_FILE}`);
  success(`Created ${GUARD_CONVENTIONS_FILE}`);
  success(`Created ${GUARD_BASELINE_FILE}`);
  success(`Created ${GUARD_BASELINE_META_FILE}`);
  success(`Created ${GUARD_PROJECT_FILE}`);
  success(`Created ${GUARD_AGENT_FILE}`);
  success(`Created ${GUARD_CONTRACTS_FILE}`);
  success(`Created ${GUARD_PROPOSALS_FILE}`);
  const proposedRules = config.rules.filter((rule) => rule.status === 'proposed').length;
  info(
    `${config.rules.length} rule(s) generated (${proposedRules} proposed); ${report.scannedFiles} source file(s) scanned.`,
  );
  dim(
    'Existing findings are baselined. New violations will be reported by `codapult-guard check`.',
  );
}

export function guardAnalyzeCommand(): void {
  const root = getRoot();
  const { model: projectModel, metrics } = discoverProjectWithMetrics(root, {
    persistCache: true,
  });
  writeProjectModel(root, projectModel);
  writeGuardMemory(root, projectModel);
  const revision = writeProjectSnapshot(root, projectModel);
  heading('Codapult Guard Analyze');
  success(
    `Updated ${GUARD_PROJECT_FILE}, ${GUARD_ARCHITECTURE_FILE}, and ${GUARD_CONVENTIONS_FILE}`,
  );
  info(
    `${projectModel.files.length} file(s), ${projectModel.modules.length} module(s), ${projectModel.insights.cycles.length} cycle(s) recorded as project context.`,
  );
  dim(
    `Discovery: ${metrics.durationMs} ms; cache ${metrics.cacheHit ? 'hit' : metrics.cacheAvailable ? 'available' : 'cold'}; ${metrics.modules} module(s), ${metrics.changedFiles} changed file(s).`,
  );
  dim(`Snapshot: ${GUARD_HISTORY_DIR}/${revision}.json`);
}

export function guardProposeCommand(options: { json?: boolean } = {}): void {
  const root = getRoot();
  const model = discoverProject(root);
  const config = loadGuardConfig(root) ?? buildGeneratedGuardConfig(model);
  const proposals = buildGuardProposals(model, config);
  const previous = loadGuardProposals(root);
  writeGuardProposals(root, {
    ...proposals,
    ...(previous?.decisions ? { decisions: previous.decisions } : {}),
  });
  const result = {
    ...proposals,
    freshness: getGuardProposalFreshness(model, proposals),
    instructions:
      'Give this proposal packet to the host AI for evidence-based contract refinement. Do not activate proposals without review.',
  };
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else {
    heading('Codapult Guard Proposals');
    info(
      `${proposals.rules.length} rule proposal(s), ${proposals.contracts.length} contract proposal(s).`,
    );
    for (const question of proposals.questions) warn(question);
    dim(`Saved ${GUARD_PROPOSALS_FILE}`);
  }
  process.exitCode = 0;
}

export function guardInstallAgentCommand(
  target = 'generic',
  options: { json?: boolean } = {},
): void {
  const normalized = target.toLowerCase();
  const targets = normalized === 'all' ? guardAgentTargets : [normalized as GuardAgentTarget];
  if (!targets.every((item) => guardAgentTargets.includes(item))) {
    fail(`Unknown agent target. Choose one of: ${guardAgentTargets.join(', ')}, all.`);
    process.exitCode = 1;
    return;
  }
  const results =
    targets.length === 1
      ? [installGuardAgentInstructions(getRoot(), targets.at(0) ?? 'generic')]
      : installGuardAgentTargets(getRoot(), targets);
  if (options.json) console.log(JSON.stringify(results, null, 2));
  else {
    heading('Codapult Guard Agent Integration');
    for (const result of results) success(`${result.action} ${result.path}`);
  }
  process.exitCode = 0;
}

export function guardDoctorCommand(options: { json?: boolean } = {}): void {
  const report = diagnoseGuard(getRoot());
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    heading('Codapult Guard Doctor');
    for (const item of report.items) {
      if (item.status === 'ok') success(`${item.path}: ok`);
      else if (item.status === 'missing') warn(`${item.path}: missing`);
      else fail(`${item.path}: invalid`);
    }
    if (report.recommendation) dim(report.recommendation);
    else success('Guard state is healthy.');
  }
  process.exitCode = report.status === 'fail' ? 1 : 0;
}

export function guardHistoryCommand(): void {
  const snapshots = listGuardSnapshots(getRoot());
  heading('Codapult Guard History');
  if (snapshots.length === 0) {
    info('No Guard snapshots found. Run `codapult-guard analyze`.');
    return;
  }
  for (const snapshot of snapshots) {
    info(
      `${snapshot.revision}: ${snapshot.files} files, ${snapshot.modules} modules, ${snapshot.cycles} cycles`,
    );
  }
}

export function guardHistoryDiffCommand(
  from: string,
  to: string,
  options: { json?: boolean } = {},
): void {
  const diff = diffGuardSnapshots(getRoot(), from, to);
  if (!diff) {
    fail(`Could not load snapshots '${from}' and '${to}'.`);
    process.exitCode = 1;
    return;
  }
  if (options.json) console.log(JSON.stringify(diff, null, 2));
  else {
    heading(`Guard Snapshot Diff: ${from} → ${to}`);
    info(`Added files: ${diff.addedFiles.length}`);
    info(`Removed files: ${diff.removedFiles.length}`);
    info(`Added dependencies: ${diff.addedDependencies.join(', ') || 'none'}`);
    info(`Removed dependencies: ${diff.removedDependencies.join(', ') || 'none'}`);
    info(
      `Capabilities: +${diff.addedCapabilities.join(', ') || 'none'} / -${diff.removedCapabilities.join(', ') || 'none'}`,
    );
    info(`Cycles: ${diff.cycles.from} → ${diff.cycles.to}`);
  }
  process.exitCode = 0;
}

export function guardVerifyCommand(
  options: {
    checks?: string;
    changed?: boolean;
    json?: boolean;
    requirement?: string;
    tools?: GuardToolMode;
    strict?: boolean;
    projectChecks?: boolean;
  } = {},
): void {
  const root = getRoot();
  const requirement = readRequirement(root, options.requirement);
  if (options.requirement && !requirement) return;
  const checks = options.checks
    ?.split(',')
    .map((check) => check.trim())
    .filter((check): check is GuardVerificationCheck =>
      ['lint', 'typecheck', 'test', 'build'].includes(check),
    );
  const result = runGuardVerification(root, {
    checks,
    changedOnly: options.changed,
    requirement,
    tools: options.tools,
    strict: options.strict,
    projectChecks: options.projectChecks,
  });
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === 'ok' ? 0 : 1;
    return;
  }
  heading('Codapult Guard Verify');
  if (result.status === 'not-configured') {
    fail('Guard is not initialized. Run `codapult-guard init` first.');
    process.exitCode = 1;
    return;
  }
  for (const [name, check] of Object.entries(result.checks)) {
    if (check.status === 'passed') success(`${name}: passed`);
    else if (check.status === 'not-configured') dim(`${name}: not configured`);
    else fail(`${name}: failed (exit ${check.exitCode})`);
  }
  for (const [name, check] of Object.entries(result.adapters ?? {})) {
    if (check.status === 'passed') success(`${name}: passed`);
    else if (check.status === 'not-configured') dim(`${name}: not configured`);
    else fail(`${name}: failed (exit ${check.exitCode})`);
  }
  const findings = result.architecture?.findings ?? [];
  if (findings.length === 0) success('architecture: no new regressions');
  else renderFindings(findings);
  for (const issue of result.contractIssues) warn(`[${issue.contractId}] ${issue.message}`);
  if (result.contractIssues.length > 0) fail(`contracts: ${result.contractIssues.length} invalid`);
  dim(`requirements: ${result.requirement.message}`);
  process.exitCode = result.status === 'ok' ? 0 : 1;
}

export function guardCheckCommand(
  options: { changed?: boolean; json?: boolean; sarif?: boolean } = {},
): void {
  const root = getRoot();
  const config = loadGuardConfig(root);
  if (!config) {
    if (options.json) {
      console.log(JSON.stringify({ configured: false, error: 'Guard is not initialized' }));
      process.exitCode = 1;
      return;
    }
    fail(`Guard is not initialized. Run \`codapult-guard init\` first.`);
    process.exitCode = 1;
    return;
  }
  const report = scanGuard(root, config, {
    changedOnly: options.changed,
    baseline: loadBaseline(root),
    includeArchitectureInsights: true,
  });
  const contractIssues = validateGuardContracts(root, config.contracts ?? []);
  const errors = report.findings.filter((finding) => finding.severity === 'error').length;
  const warnings = report.findings.filter((finding) => finding.severity === 'warning').length;
  const contractFindings: GuardFinding[] = contractIssues.map((issue) => ({
    ruleId: `contract:${issue.contractId}`,
    severity: 'error',
    file: issue.value,
    line: 1,
    importPath: 'contract',
    message: issue.message,
    fingerprint: `contract-invalid|${issue.contractId}|${issue.field}|${issue.value}`,
  }));
  if (options.sarif) {
    console.log(
      JSON.stringify(guardFindingsToSarif([...report.findings, ...contractFindings]), null, 2),
    );
    process.exitCode = errors > 0 || contractIssues.length > 0 ? 1 : 0;
    return;
  }
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          status:
            errors > 0 || contractIssues.length > 0 ? 'fail' : warnings > 0 ? 'warning' : 'ok',
          outcome: classifyGuardOutcome({ errors: errors + contractIssues.length, warnings }),
          errors,
          warnings,
          contractIssues,
          report,
        },
        null,
        2,
      ),
    );
    process.exitCode = errors > 0 || contractIssues.length > 0 ? 1 : 0;
    return;
  }
  heading(`Codapult Guard${options.changed ? ' (changed files)' : ''}`);
  dim(
    `Scanned ${report.scannedFiles} source file(s); suppressed ${report.suppressed} baseline finding(s).`,
  );
  renderFindings(report.findings);
  for (const issue of contractIssues) warn(`[${issue.contractId}] ${issue.message}`);
  if (errors > 0 || contractIssues.length > 0)
    fail(`${errors + contractIssues.length} issue(s) found`);
  else if (warnings > 0) warn(`${warnings} warning(s) found`);
  else success('No new guard violations found.');
  process.exitCode = errors > 0 || contractIssues.length > 0 ? 1 : 0;
}

export function guardAuditCommand(options: { json?: boolean } = {}): void {
  const root = getRoot();
  const config = loadGuardConfig(root);
  if (!config) {
    if (options.json) {
      console.log(JSON.stringify({ configured: false, error: 'Guard is not initialized' }));
      process.exitCode = 1;
      return;
    }
    fail(`Guard is not initialized. Run \`codapult-guard init\` first.`);
    process.exitCode = 1;
    return;
  }
  const report = scanGuard(root, config, { includeArchitectureInsights: true });
  const contractIssues = validateGuardContracts(root, config.contracts ?? []);
  const errors = report.findings.filter((finding) => finding.severity === 'error').length;
  const warnings = report.findings.filter((finding) => finding.severity === 'warning').length;
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          status:
            errors > 0 || contractIssues.length > 0 ? 'fail' : warnings > 0 ? 'warning' : 'ok',
          errors,
          warnings,
          outcome: classifyGuardOutcome({
            errors: errors + contractIssues.length,
            warnings,
          }),
          contractIssues,
          report,
        },
        null,
        2,
      ),
    );
    process.exitCode = errors > 0 || contractIssues.length > 0 ? 1 : 0;
    return;
  }
  heading('Codapult Guard Audit');
  dim(`Scanned ${report.scannedFiles} source file(s); baseline is ignored for this full audit.`);
  renderFindings(report.findings);
  for (const issue of contractIssues) warn(`[${issue.contractId}] ${issue.message}`);
  if (errors > 0) fail(`${errors} error(s) found`);
  else if (warnings > 0 || contractIssues.length > 0) {
    warn(`${warnings + contractIssues.length} warning(s) found`);
  } else success('No Guard issues found.');
  process.exitCode = errors > 0 || contractIssues.length > 0 ? 1 : 0;
}

export function guardBaselineCommand(
  action: 'list' | 'accept' | 'remove',
  ids?: string,
  options: { all?: boolean; reason?: string; json?: boolean } = {},
): void {
  const root = getRoot();
  const baseline = loadBaseline(root);
  if (action === 'list') {
    const result = { count: baseline.size, fingerprints: [...baseline].sort() };
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      heading('Codapult Guard Baseline');
      info(`${result.count} fingerprint(s)`);
      for (const fingerprint of result.fingerprints) dim(fingerprint);
    }
    process.exitCode = 0;
    return;
  }
  const selected = options.all
    ? [
        ...scanGuard(
          root,
          loadGuardConfig(root) ?? buildGeneratedGuardConfig(discoverProject(root)),
          {
            includeArchitectureInsights: true,
          },
        ).findings.map((finding) => finding.fingerprint),
      ]
    : (ids ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
  if (selected.length === 0) {
    fail(`Specify fingerprints or use --all to ${action} findings.`);
    process.exitCode = 1;
    return;
  }
  const next = updateBaseline(
    root,
    action === 'accept'
      ? { add: selected, reason: options.reason }
      : { remove: selected, reason: options.reason },
  );
  const result = { action, changed: selected.length, count: next.size, fingerprints: selected };
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else
    success(
      `${action === 'accept' ? 'Accepted' : 'Removed'} ${selected.length} baseline fingerprint(s).`,
    );
  process.exitCode = 0;
}

export function guardRulesApproveCommand(ids?: string, options: { all?: boolean } = {}): void {
  const root = getRoot();
  const config = loadGuardConfig(root);
  if (!config) {
    fail('Guard is not initialized. Run `codapult-guard init` first.');
    process.exitCode = 1;
    return;
  }
  const requested = new Set(
    ids
      ?.split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  );
  const proposed = config.rules.filter((rule) => rule.status === 'proposed');
  const selected = proposed.filter((rule) => options.all || requested.has(rule.id));
  if (!options.all && selected.length === 0) {
    fail('Specify proposed rule IDs or use `codapult-guard rules approve --all`.');
    process.exitCode = 1;
    return;
  }
  const selectedIds = new Set(selected.map((rule) => rule.id));
  writeGuardConfig(root, {
    ...config,
    rules: config.rules.map((rule) =>
      selectedIds.has(rule.id) ? { ...rule, status: 'active' as const } : rule,
    ),
  });
  recordGuardProposalDecision(
    root,
    selected.map((rule) => ({ id: rule.id, type: 'rule', decision: 'approved' as const })),
  );
  for (const rule of selected) success(`Activated ${rule.id}`);
  process.exitCode = 0;
}

export function guardContractsApproveCommand(ids?: string, options: { all?: boolean } = {}): void {
  const root = getRoot();
  const config = loadGuardConfig(root);
  if (!config) {
    fail('Guard is not initialized. Run `codapult-guard init` first.');
    process.exitCode = 1;
    return;
  }
  const requested = new Set(
    ids
      ?.split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  );
  const proposed = (config.contracts ?? []).filter((contract) => contract.status === 'proposed');
  const selected = proposed.filter((contract) => options.all || requested.has(contract.id));
  if (!options.all && selected.length === 0) {
    fail('Specify proposed contract IDs or use `codapult-guard contracts approve --all`.');
    process.exitCode = 1;
    return;
  }
  const selectedIds = new Set(selected.map((contract) => contract.id));
  writeGuardConfig(root, {
    ...config,
    contracts: (config.contracts ?? []).map((contract) =>
      selectedIds.has(contract.id) ? { ...contract, status: 'active' as const } : contract,
    ),
  });
  recordGuardProposalDecision(
    root,
    selected.map((contract) => ({
      id: contract.id,
      type: 'contract',
      decision: 'approved' as const,
    })),
  );
  for (const contract of selected) success(`Activated ${contract.id}`);
  process.exitCode = 0;
}

export function guardContractsRejectCommand(ids?: string, options: { all?: boolean } = {}): void {
  const root = getRoot();
  const config = loadGuardConfig(root);
  if (!config) {
    fail('Guard is not initialized. Run `codapult-guard init` first.');
    process.exitCode = 1;
    return;
  }
  const requested = new Set(
    ids
      ?.split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  );
  const proposed = (config.contracts ?? []).filter((contract) => contract.status === 'proposed');
  const selected = proposed.filter((contract) => options.all || requested.has(contract.id));
  if (!options.all && selected.length === 0) {
    fail('Specify proposed contract IDs or use `codapult-guard contracts reject --all`.');
    process.exitCode = 1;
    return;
  }
  writeGuardConfig(root, {
    ...config,
    contracts: config.contracts ?? [],
  });
  recordGuardProposalDecision(
    root,
    selected.map((contract) => ({
      id: contract.id,
      type: 'contract',
      decision: 'rejected' as const,
    })),
  );
  for (const contract of selected) success(`Rejected ${contract.id}`);
  process.exitCode = 0;
}

export function guardReviewCommand(
  options: { maxDiffChars?: string; requirement?: string; base?: string } = {},
): void {
  const root = getRoot();
  const requirement = readRequirement(root, options.requirement);
  if (options.requirement && !requirement) return;
  const config = loadGuardConfig(root);
  if (!config) {
    fail(`Guard is not initialized. Run \`codapult-guard init\` first.`);
    process.exitCode = 1;
    return;
  }
  const maxDiffChars = options.maxDiffChars ? Number(options.maxDiffChars) : 120_000;
  if (!Number.isInteger(maxDiffChars) || maxDiffChars < 1) {
    fail('--max-diff-chars must be a positive integer.');
    process.exitCode = 1;
    return;
  }
  const packet = buildGuardReviewPacket(
    root,
    config,
    loadBaseline(root),
    maxDiffChars,
    true,
    requirement,
    options.base,
  );
  console.log(JSON.stringify(packet, null, 2));
  if (packet.diffError) process.exitCode = 1;
}

export function guardIsInitialized(root: string): boolean {
  return existsSync(resolve(root, GUARD_RULES_FILE));
}
