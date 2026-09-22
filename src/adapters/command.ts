import { execFileSync } from 'node:child_process';

export interface CommandResult {
  command: string;
  status: 'passed' | 'failed' | 'not-configured';
  passed: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  truncated?: boolean;
}

const MAX_OUTPUT_CHARS = 20_000;
const MAX_BUFFER_BYTES = 2_000_000;

function redactOutput(value: string): string {
  return value
    .replace(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, '[REDACTED PRIVATE KEY]')
    .replace(
      /\b(?:sk_(?:live|test)_|pk_(?:live|test)_|AKIA|gh[pousr]_|github_pat_)[A-Za-z0-9_-]+/g,
      '[REDACTED TOKEN]',
    )
    .replace(
      /((?:api[_-]?key|secret|token|password|authorization|database[_-]?url)\s*[:=]\s*["']?)[^\s"'`,}]+/gi,
      '$1[REDACTED]',
    );
}

function captureOutput(value: string): { value: string; truncated: boolean } {
  const redacted = redactOutput(value);
  return redacted.length > MAX_OUTPUT_CHARS
    ? { value: `${redacted.slice(0, MAX_OUTPUT_CHARS)}\n[output truncated]`, truncated: true }
    : { value: redacted, truncated: false };
}

function parseCommand(command: string): { executable: string; args: string[] } | undefined {
  const parts = command.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0 || parts.some((part) => /[;&|<>`$()]/.test(part))) return undefined;
  const [executable, ...args] = parts;
  const windowsExecutable =
    process.platform === 'win32' && /^(?:npm|npx|pnpm|yarn|bun)$/.test(executable)
      ? `${executable}.cmd`
      : executable;
  return { executable: windowsExecutable, args };
}

export function runProjectCommand(
  command: string,
  cwd: string,
  options: { timeout?: number; env?: NodeJS.ProcessEnv } = {},
): CommandResult {
  const parsed = parseCommand(command);
  if (!parsed) {
    return {
      command,
      status: 'failed',
      passed: false,
      exitCode: 2,
      stdout: '',
      stderr: 'Unsafe or empty project command rejected.',
    };
  }
  try {
    const stdout = execFileSync(parsed.executable, parsed.args, {
      cwd,
      env: { ...process.env, ...options.env },
      stdio: 'pipe',
      timeout: options.timeout ?? 120_000,
      maxBuffer: MAX_BUFFER_BYTES,
    }).toString();
    const captured = captureOutput(stdout);
    return {
      command,
      status: 'passed',
      passed: true,
      exitCode: 0,
      stdout: captured.value,
      stderr: '',
      truncated: captured.truncated,
    };
  } catch (error) {
    const execError = error as {
      status?: number;
      stdout?: Buffer;
      stderr?: Buffer;
      killed?: boolean;
      signal?: string;
      code?: string;
    };
    const exitCode = execError.status ?? 1;
    const passed = exitCode === 0;
    const stdout = captureOutput(execError.stdout?.toString() ?? '');
    const stderr = captureOutput(execError.stderr?.toString() ?? '');
    const timedOut = execError.code === 'ETIMEDOUT' || execError.signal === 'SIGTERM';
    return {
      command,
      status: passed ? 'passed' : 'failed',
      passed,
      exitCode,
      stdout: stdout.value,
      stderr: timedOut ? `${stderr.value}\n[command timed out]` : stderr.value,
      timedOut,
      truncated: stdout.truncated || stderr.truncated,
    };
  }
}

export function commandResponse(result: CommandResult): {
  content: { type: 'text'; text: string }[];
  isError: boolean;
} {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    isError: !result.passed,
  };
}
