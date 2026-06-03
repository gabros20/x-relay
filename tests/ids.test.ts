import { describe, expect, test } from 'bun:test';
import { extractHandle, extractTweetId } from '../src/ids.ts';

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
