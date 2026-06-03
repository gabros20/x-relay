import type { Err, Ok } from './types.ts';

export function ok<T>(command: string, data: T): Ok<T> {
  return { ok: true, command, data };
}

export function err(command: string, code: string, message: string, hint?: string): Err {
  const error: Err['error'] = hint !== undefined ? { code, message, hint } : { code, message };
  return { ok: false, command, error };
}

export function toJson(envelope: unknown): string {
  return JSON.stringify(envelope, null, 2);
}
