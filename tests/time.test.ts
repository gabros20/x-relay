// Set TZ before any imports so Date operations in both the module and this
// test file use UTC. This makes the formatLocal assertion timezone-robust.
process.env.TZ = 'UTC';

import { describe, expect, test } from 'bun:test';
import { formatIso8601, formatLocal } from '../src/time.ts';

const VALID_CREATED_AT = 'Wed Jun 10 16:06:30 +0000 2026';

describe('formatIso8601', () => {
  test('converts a valid Twitter created_at to ISO 8601', () => {
    expect(formatIso8601(VALID_CREATED_AT)).toBe('2026-06-10T16:06:30+00:00');
  });

  test('preserves a positive timezone offset verbatim', () => {
    expect(formatIso8601('Wed Jun 10 16:06:30 +0530 2026')).toBe('2026-06-10T16:06:30+05:30');
  });

  test('preserves a negative timezone offset verbatim', () => {
    expect(formatIso8601('Wed Jun 10 16:06:30 -0800 2026')).toBe('2026-06-10T16:06:30-08:00');
  });

  test('returns the raw string on unparseable non-empty input', () => {
    const garbage = 'not-a-date';
    expect(formatIso8601(garbage)).toBe(garbage);
  });

  test('returns undefined on empty string', () => {
    expect(formatIso8601('')).toBeUndefined();
  });

  test('returns undefined on undefined input', () => {
    expect(formatIso8601(undefined as unknown as string)).toBeUndefined();
  });
});

describe('formatLocal', () => {
  test('converts a valid Twitter created_at to YYYY-MM-DD HH:mm in local time (UTC in test env)', () => {
    // With TZ=UTC the local time equals UTC, so we can assert the exact string.
    expect(formatLocal(VALID_CREATED_AT)).toBe('2026-06-10 16:06');
  });

  test('output matches the YYYY-MM-DD HH:mm shape', () => {
    const result = formatLocal(VALID_CREATED_AT);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  test('applies a positive offset when converting to UTC (TZ=UTC env)', () => {
    // 16:06 +0530 is 10:36 UTC; with TZ=UTC local == UTC.
    expect(formatLocal('Wed Jun 10 16:06:30 +0530 2026')).toBe('2026-06-10 10:36');
  });

  test('applies a negative offset when converting to UTC (TZ=UTC env)', () => {
    // 16:06 -0800 is 00:06 UTC the next day.
    expect(formatLocal('Wed Jun 10 16:06:30 -0800 2026')).toBe('2026-06-11 00:06');
  });

  test('returns the raw string on unparseable non-empty input', () => {
    const garbage = 'garbage-date';
    expect(formatLocal(garbage)).toBe(garbage);
  });

  test('returns undefined on empty string', () => {
    expect(formatLocal('')).toBeUndefined();
  });

  test('returns undefined on undefined input', () => {
    expect(formatLocal(undefined as unknown as string)).toBeUndefined();
  });
});
