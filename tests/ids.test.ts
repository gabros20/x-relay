import { describe, expect, test } from 'bun:test';
import { extractHandle, extractTweetId, looksLikeTweetRef } from '../src/ids.ts';

describe('extractTweetId', () => {
  test('accepts a bare snowflake id', () => {
    expect(extractTweetId('1234567890123456789')).toBe('1234567890123456789');
  });

  test('pulls the id from an x.com status URL', () => {
    expect(extractTweetId('https://x.com/elonmusk/status/1234567890123456789')).toBe(
      '1234567890123456789',
    );
  });

  test('pulls the id from a twitter.com status URL with query + trailing slash', () => {
    expect(extractTweetId('https://twitter.com/jack/status/20/?s=20')).toBe('20');
  });

  test('handles the /i/web/status/ permalink form', () => {
    expect(extractTweetId('https://x.com/i/web/status/987654321')).toBe('987654321');
  });

  test('handles mobile.twitter.com', () => {
    expect(extractTweetId('https://mobile.twitter.com/user/status/555')).toBe('555');
  });

  test('rejects a non-status URL', () => {
    expect(extractTweetId('https://x.com/elonmusk')).toBeNull();
  });

  test('rejects junk', () => {
    expect(extractTweetId('not a tweet')).toBeNull();
    expect(extractTweetId('')).toBeNull();
  });
});

describe('looksLikeTweetRef', () => {
  test('true for an x.com status URL (extract also succeeds)', () => {
    const url = 'https://x.com/elonmusk/status/1234567890123456789';
    expect(looksLikeTweetRef(url)).toBe(true);
    expect(extractTweetId(url)).toBe('1234567890123456789');
  });

  test('true for an x.com URL without a status segment (extract fails)', () => {
    expect(looksLikeTweetRef('https://x.com/someuser')).toBe(true);
    expect(extractTweetId('https://x.com/someuser')).toBeNull();
  });

  test('true for a status URL with an empty id (extract fails)', () => {
    expect(looksLikeTweetRef('https://x.com/user/status/')).toBe(true);
    expect(extractTweetId('https://x.com/user/status/')).toBeNull();
  });

  test('true for a bare snowflake id', () => {
    expect(looksLikeTweetRef('1234567890')).toBe(true);
  });

  test('true for twitter.com and mobile.twitter.com hosts', () => {
    expect(looksLikeTweetRef('https://twitter.com/jack/status/20')).toBe(true);
    expect(looksLikeTweetRef('https://mobile.twitter.com/user/status/555')).toBe(true);
  });

  test('false for non-URL garbage', () => {
    expect(looksLikeTweetRef('foo bar')).toBe(false);
  });

  test('false for a non-X URL', () => {
    expect(looksLikeTweetRef('https://example.com/status/123')).toBe(false);
  });
});

describe('extractHandle', () => {
  test('strips a leading @', () => {
    expect(extractHandle('@elonmusk')).toBe('elonmusk');
  });

  test('accepts a bare handle', () => {
    expect(extractHandle('elonmusk')).toBe('elonmusk');
  });

  test('pulls the handle from a profile URL', () => {
    expect(extractHandle('https://x.com/elonmusk')).toBe('elonmusk');
  });

  test('pulls the author handle from a status URL', () => {
    expect(extractHandle('https://twitter.com/jack/status/20')).toBe('jack');
  });

  test('rejects reserved path segments', () => {
    expect(extractHandle('https://x.com/home')).toBeNull();
    expect(extractHandle('https://x.com/search?q=foo')).toBeNull();
    expect(extractHandle('https://x.com/i/web/status/5')).toBeNull();
  });

  test('rejects an over-long or invalid handle', () => {
    expect(extractHandle('@thishandleiswaytoolong')).toBeNull();
    expect(extractHandle('bad-handle!')).toBeNull();
    expect(extractHandle('')).toBeNull();
  });
});
