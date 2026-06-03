import { describe, expect, test } from 'bun:test';
import { buildSearchQuery } from '../src/commands/query.ts';

describe('buildSearchQuery', () => {
  test('returns the bare query when no operators are given', () => {
    expect(buildSearchQuery({ query: 'ai agents' })).toBe('ai agents');
  });

  test('appends from/since/until/lang/min_faves operators', () => {
    expect(
      buildSearchQuery({
        query: 'ai agents',
        from: 'karpathy',
        since: '2026-01-01',
        until: '2026-02-01',
        lang: 'en',
        minFaves: 100,
      }),
    ).toBe('ai agents from:karpathy since:2026-01-01 until:2026-02-01 lang:en min_faves:100');
  });

  test('maps filters, supporting negation with a leading dash', () => {
    expect(buildSearchQuery({ query: 'x', filter: ['media', '-replies'] })).toBe(
      'x filter:media -filter:replies',
    );
  });

  test('works with operators only (empty base query)', () => {
    expect(buildSearchQuery({ query: '', from: 'nasa' })).toBe('from:nasa');
  });

  test('trims and ignores blank parts', () => {
    expect(buildSearchQuery({ query: '  spaced  ', lang: '' })).toBe('spaced');
  });
});
