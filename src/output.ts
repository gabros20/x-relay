import type { Err, Ok } from './types.ts';

export function ok<T>(command: string, data: T): Ok<T> {
  return { ok: true, command, data };
}

export function err(
  command: string,
  code: string,
  message: string,
  hint?: string,
  status?: number,
  retryAfterMs?: number,
): Err {
  const error: Err['error'] = { code, message };
  if (hint !== undefined) error.hint = hint;
  if (status !== undefined) error.status = status;
  if (retryAfterMs !== undefined) error.retryAfterMs = retryAfterMs;
  return { ok: false, command, error };
}

export function toJson(envelope: unknown): string {
  return JSON.stringify(envelope, null, 2);
}
