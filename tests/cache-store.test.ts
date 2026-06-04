import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CacheFile,
  allTweets,
  cachePath,
  loadCache,
  mergeTweets,
  saveCache,
} from '../src/cache/store.ts';
import type { Tweet } from '../src/types.ts';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'xrelay-test-'));
}

function tweet(id: string): Tweet {
  return {
    id,
    url: `https://x.com/u/status/${id}`,
    text: `tweet ${id}`,
    author: { id: 'a1', handle: 'u', name: 'U', verified: false },
    metrics: {},
  };
}

describe('saveCache / loadCache', () => {
  test('round-trips a file with a couple of tweets', () => {
    const dir = tmpDir();
    const file: CacheFile = {
      source: 'bookmarks',
      handle: 'me',
      tweets: { '10': tweet('10'), '20': tweet('20') },
    };
    saveCache(file, dir);
    const loaded = loadCache('bookmarks', dir);
    expect(loaded).toEqual(file);
  });

  test('missing file returns the empty shape', () => {
    const dir = tmpDir();
    expect(loadCache('posts', dir)).toEqual({ source: 'posts', tweets: {} });
  });

  test('corrupt non-JSON file returns the empty shape (no throw)', () => {
    const dir = tmpDir();
    writeFileSync(cachePath('bookmarks', dir), 'not json {{{');
    expect(loadCache('bookmarks', dir)).toEqual({ source: 'bookmarks', tweets: {} });
  });

  test('saveCache creates the dir if absent', () => {
    const dir = join(tmpDir(), 'nested', 'deep');
    const file: CacheFile = { source: 'posts', tweets: { '1': tweet('1') } };
    saveCache(file, dir);
    expect(loadCache('posts', dir)).toEqual(file);
  });
});

describe('mergeTweets', () => {
  test('adds new tweets and sets watermark to the larger id', () => {
    const file: CacheFile = { source: 'posts', tweets: {} };
    const res = mergeTweets(file, [tweet('10'), tweet('20')]);
    expect(res).toEqual({ added: 2 });
    expect(file.watermark).toBe('20');
    expect(Object.keys(file.tweets).sort()).toEqual(['10', '20']);
  });

  test('counts only new ids and overwrites existing on overlap', () => {
    const file: CacheFile = { source: 'posts', tweets: {} };
    mergeTweets(file, [tweet('10'), tweet('20')]);
    const repaired: Tweet = { ...tweet('20'), text: 'repaired' };
    const res = mergeTweets(file, [repaired, tweet('30')]);
    expect(res).toEqual({ added: 1 });
    expect(file.tweets['20']?.text).toBe('repaired');
    expect(file.watermark).toBe('30');
  });

  test('watermark reflects the max snowflake id via BigInt compare', () => {
    const file: CacheFile = { source: 'bookmarks', tweets: {} };
    // Longer string is lexicographically smaller-first but numerically larger.
    mergeTweets(file, [tweet('1999999999999999999'), tweet('2000000000000000001')]);
    expect(file.watermark).toBe('2000000000000000001');
  });
});

describe('allTweets', () => {
  test('returns the values of the tweets map', () => {
    const file: CacheFile = { source: 'posts', tweets: { '1': tweet('1'), '2': tweet('2') } };
    expect(allTweets(file)).toEqual([tweet('1'), tweet('2')]);
  });
});
