export type GuardErrorCode =
  | 'GUARD_NOT_CONFIGURED'
  | 'GUARD_CONFIG_INVALID'
  | 'GUARD_STATE_BUSY'
  | 'GUARD_STATE_STALE'
  | 'GUARD_POLICY_BASE_INVALID'
  | 'GUARD_POLICY_CHANGED'
  | 'GUARD_INVALID_INPUT';

export interface GuardErrorPayload {
  status: 'error';
  outcome: 'not-configured' | 'error';
  configured: boolean;
  errorCode: GuardErrorCode;
  message: string;
  recoverable: boolean;
  hint?: string | undefined;
}

export function guardErrorPayload(
  errorCode: GuardErrorCode,
  message: string,
  options: Pick<GuardErrorPayload, 'configured' | 'recoverable' | 'outcome'> &
    Partial<Pick<GuardErrorPayload, 'hint'>>,
): GuardErrorPayload {
  return {
    status: 'error',
    outcome: options.outcome,
    configured: options.configured,
    errorCode,
    message,
    recoverable: options.recoverable,
    ...(options.hint ? { hint: options.hint } : {}),
  };
}
