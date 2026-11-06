import { createHash } from 'node:crypto';

export type VerificationScopeFileDigest =
  | { path: string; status: 'present'; sha256: string }
  // The optional deleted digest is accepted only when reading old local history.
  | { path: string; status: 'deleted'; sha256?: string | undefined }
  | { path: string; status: 'unavailable'; sha256?: never };

export interface VerificationScopeFingerprintInput {
  policyFingerprint: string;
  tool: { name: string; version: string };
  files: VerificationScopeFileDigest[];
  source?:
    | {
        repository: string | null;
        commit: string | null;
        headSha: string | null;
        baseSha: string | null;
        baseCommit: string | null;
      }
    | undefined;
}

export function isMissingVerificationScopePathError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return error.code === 'ENOENT' || error.code === 'ENOTDIR';
}

/** Hash the version-1 verification context using the documented stable property order. */
export function computeVerificationScopeFingerprint(
  input: VerificationScopeFingerprintInput,
): string {
  const files = input.files.map((file) =>
    file.status === 'present'
      ? { path: file.path, status: file.status, sha256: file.sha256 }
      : { path: file.path, status: file.status },
  );
  return createHash('sha256')
    .update(
      JSON.stringify({
        algorithm: 'sha256',
        policyFingerprint: input.policyFingerprint,
        tool: { name: input.tool.name, version: input.tool.version },
        files,
        ...(input.source
          ? {
              source: {
                repository: input.source.repository,
                commit: input.source.commit,
                headSha: input.source.headSha,
                baseSha: input.source.baseSha,
                baseCommit: input.source.baseCommit,
              },
            }
          : {}),
      }),
      'utf8',
    )
    .digest('hex');
}
