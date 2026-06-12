// Set TZ before any imports so formatLocal assertions are timezone-robust.
process.env.TZ = 'UTC';

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadArchive, mergeArchive, saveArchive, toArchiveTweet } from '../src/archive.ts';
import type { ArchiveFile, ArchiveTweet, ArticleBrief, MediaItem, Tweet } from '../src/types.ts';

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeAuthor() {
  return {
    id: '44196397',
    handle: 'elonmusk',
    name: 'Elon Musk',
    verified: true,
    followers: 200_000_000,
    avatar: 'https://pbs.twimg.com/avatar.jpg',
  };
}

function makeMetrics() {
  return {
    likes: 100,
    retweets: 20,
    replies: 5,
    quotes: 3,
    bookmarks: 7,
    views: 12345,
  };
}

function baseTweet(): Tweet {
  return {
    id: '1500000000000000001',
    url: 'https://x.com/elonmusk/status/1500000000000000001',
    text: 'Hello world',
    lang: 'en',
    createdAt: 'Wed Jun 10 16:06:30 +0000 2026',
    author: makeAuthor(),
    metrics: makeMetrics(),
    hashtags: ['rockets'],
    mentions: ['NASA'],
    urls: ['https://example.com'],
    isReply: false,
    isRetweet: false,
    isQuote: false,
    conversationId: '1500000000000000001',
  };
}

function tweetWithMedia(): Tweet {
  const items: MediaItem[] = [
    { type: 'photo', url: 'https://pbs.twimg.com/media/photo.jpg', width: 1200, height: 800 },
    {
      type: 'video',
      url: 'https://video.twimg.com/ext_tw_video/best.mp4',
      width: 1280,
      height: 720,
      thumbnail: 'https://pbs.twimg.com/media/thumb.jpg',
      durationMs: 30000,
      bitrate: 2176000,
    },
  ];
  return { ...baseTweet(), mediaItems: items };
}

function tweetWithArticle(): Tweet {
  const article: ArticleBrief = { title: 'My Article Title', markdown: 'Hello world' };
  return { ...baseTweet(), id: '1500000000000000002', article };
}

function tweetWithQuoted(): Tweet {
  const quoted: Tweet = { ...baseTweet(), id: '1400000000000000000', text: 'The quoted tweet.' };
  return { ...baseTweet(), quoted, isQuote: true };
}

function makeArchiveTweet(id: string, overrides?: Partial<ArchiveTweet>): ArchiveTweet {
  return {
    id,
    url: `https://x.com/elonmusk/status/${id}`,
    text: `Tweet ${id}`,
    author: makeAuthor(),
    metrics: makeMetrics(),
    ...overrides,
  };
}

function makeArchiveFile(tweets: ArchiveTweet[]): ArchiveFile {
  return {
    schema: 'x-relay/archive@1',
    source: 'bookmarks',
    generatedAt: '2026-06-10T16:06:30+00:00',
    count: tweets.length,
    newestId: tweets.length > 0 ? tweets[0].id : undefined,
    tweets,
  };
}

// ── toArchiveTweet ──────────────────────────────────────────────────────────

describe('toArchiveTweet', () => {
  test('sets createdAtISO and createdAtLocal from createdAt', () => {
    const tweet = toArchiveTweet(baseTweet());
    expect(tweet.createdAt).toBe('Wed Jun 10 16:06:30 +0000 2026');
    expect(tweet.createdAtISO).toBe('2026-06-10T16:06:30+00:00');
    expect(tweet.createdAtLocal).toBe('2026-06-10 16:06');
  });

  test('omits createdAtISO/Local when createdAt is absent', () => {
    const t = { ...baseTweet() };
    t.createdAt = undefined;
    const tweet = toArchiveTweet(t);
    expect(tweet.createdAtISO).toBeUndefined();
    expect(tweet.createdAtLocal).toBeUndefined();
  });

  test('maps mediaItems to media array', () => {
    const tweet = toArchiveTweet(tweetWithMedia());
    expect(tweet.media).toBeDefined();
    expect(tweet.media?.length).toBe(2);
    expect(tweet.media?.[0]).toMatchObject({
      type: 'photo',
      url: 'https://pbs.twimg.com/media/photo.jpg',
      width: 1200,
      height: 800,
    });
    expect(tweet.media?.[1]).toMatchObject({
      type: 'video',
      url: 'https://video.twimg.com/ext_tw_video/best.mp4',
    });
  });

  test('media is absent when no mediaItems', () => {
    const tweet = toArchiveTweet(baseTweet());
    expect(tweet.media).toBeUndefined();
  });

  test('includes article when present', () => {
    const tweet = toArchiveTweet(tweetWithArticle());
    expect(tweet.article).toBeDefined();
    expect(tweet.article?.title).toBe('My Article Title');
    expect(tweet.article?.markdown).toBe('Hello world');
  });

  test('article is absent when tweet has no article', () => {
    const tweet = toArchiveTweet(baseTweet());
    expect(tweet.article).toBeUndefined();
  });

  test('recursively maps quoted tweet via toArchiveTweet', () => {
    const tweet = toArchiveTweet(tweetWithQuoted());
    expect(tweet.quoted).toBeDefined();
    expect(tweet.quoted?.id).toBe('1400000000000000000');
    expect(tweet.quoted?.text).toBe('The quoted tweet.');
    // Nested quoted also has computed ISO timestamps
    expect(tweet.quoted?.createdAtISO).toBe('2026-06-10T16:06:30+00:00');
  });

  test('quoted is absent when tweet has no quoted', () => {
    const tweet = toArchiveTweet(baseTweet());
    expect(tweet.quoted).toBeUndefined();
  });

  test('passes through author, metrics, lang, urls, hashtags, mentions, isReply, isRetweet, isQuote, retweetedBy, conversationId, id, url, text', () => {
    const t: Tweet = {
      ...baseTweet(),
      retweetedBy: 'retweeter',
      isRetweet: true,
    };
    const tweet = toArchiveTweet(t);
    expect(tweet.id).toBe(t.id);
    expect(tweet.url).toBe(t.url);
    expect(tweet.text).toBe(t.text);
    expect(tweet.lang).toBe(t.lang);
    expect(tweet.author).toEqual(t.author);
    expect(tweet.metrics).toEqual(t.metrics);
    expect(tweet.hashtags).toEqual(t.hashtags);
    expect(tweet.mentions).toEqual(t.mentions);
    expect(tweet.urls).toEqual(t.urls);
    expect(tweet.isReply).toBe(t.isReply);
    expect(tweet.isRetweet).toBe(t.isRetweet);
    expect(tweet.isQuote).toBe(t.isQuote);
    expect(tweet.retweetedBy).toBe('retweeter');
    expect(tweet.conversationId).toBe(t.conversationId);
  });
});

// ── mergeArchive ─────────────────────────────────────────────────────────────

describe('mergeArchive — basic prepend + dedup', () => {
  const GEN_AT = '2026-06-12T10:00:00+00:00';

  test('prepends fresh tweets ahead of existing', () => {
    const existing = makeArchiveFile([makeArchiveTweet('200'), makeArchiveTweet('100')]);
    const fresh = [makeArchiveTweet('400'), makeArchiveTweet('300')];
    const { file } = mergeArchive(existing, fresh, { generatedAt: GEN_AT });
    expect(file.tweets.map((t) => t.id)).toEqual(['400', '300', '200', '100']);
  });

  test('fresh wins on dedup (duplicate id: fresh replaces older dup)', () => {
    const oldTweet = makeArchiveTweet('200', { text: 'old text' });
    const existing = makeArchiveFile([oldTweet, makeArchiveTweet('100')]);
    const freshTweet = makeArchiveTweet('200', { text: 'fresh text' });
    const { file } = mergeArchive(existing, [freshTweet], { generatedAt: GEN_AT });
    const found = file.tweets.find((t) => t.id === '200');
    expect(found?.text).toBe('fresh text');
  });

  test('dedup preserves fresh near top', () => {
    const existing = makeArchiveFile([makeArchiveTweet('200'), makeArchiveTweet('100')]);
    const fresh = [makeArchiveTweet('300'), makeArchiveTweet('200', { text: 'refreshed' })];
    const { file } = mergeArchive(existing, fresh, { generatedAt: GEN_AT });
    // fresh tweets come first; '200' from existing is dropped
    expect(file.tweets.map((t) => t.id)).toEqual(['300', '200', '100']);
    expect(file.tweets[1].text).toBe('refreshed');
  });

  test('added = number of truly new ids added (not duplicates)', () => {
    const existing = makeArchiveFile([makeArchiveTweet('200'), makeArchiveTweet('100')]);
    const fresh = [makeArchiveTweet('300'), makeArchiveTweet('200', { text: 'refreshed' })];
    const { added } = mergeArchive(existing, fresh, { generatedAt: GEN_AT });
    expect(added).toBe(1); // only '300' is new
  });

  test('recomputes count = tweets.length', () => {
    const existing = makeArchiveFile([makeArchiveTweet('200'), makeArchiveTweet('100')]);
    const fresh = [makeArchiveTweet('300'), makeArchiveTweet('400')];
    const { file } = mergeArchive(existing, fresh, { generatedAt: GEN_AT });
    expect(file.count).toBe(4);
    expect(file.tweets.length).toBe(4);
  });

  test('recomputes newestId = max snowflake id (BigInt compare)', () => {
    // '999...' is numerically larger than '200' even though 200 is at index 0
    const existing = makeArchiveFile([makeArchiveTweet('200')]);
    const fresh = [makeArchiveTweet('9999999999999999999')];
    const { file } = mergeArchive(existing, fresh, { generatedAt: GEN_AT });
    expect(file.newestId).toBe('9999999999999999999');
  });

  test('generatedAt is set from the argument', () => {
    const existing = makeArchiveFile([makeArchiveTweet('100')]);
    const { file } = mergeArchive(existing, [], { generatedAt: GEN_AT });
    expect(file.generatedAt).toBe(GEN_AT);
  });

  test('existing=null starts from scratch', () => {
    const fresh = [makeArchiveTweet('300'), makeArchiveTweet('200')];
    const { file, added } = mergeArchive(null, fresh, { generatedAt: GEN_AT });
    expect(file.tweets.map((t) => t.id)).toEqual(['300', '200']);
    expect(added).toBe(2);
  });
});

describe('mergeArchive — prune', () => {
  const GEN_AT = '2026-06-12T10:00:00+00:00';

  test('prune replaces file.tweets with exactly fresh (no existing retained)', () => {
    const existing = makeArchiveFile([makeArchiveTweet('200'), makeArchiveTweet('100')]);
    const fresh = [makeArchiveTweet('300')];
    const { file } = mergeArchive(existing, fresh, { prune: true, generatedAt: GEN_AT });
    expect(file.tweets.map((t) => t.id)).toEqual(['300']);
  });

  test('prune: added = fresh.length (all are "added" since we replaced)', () => {
    const existing = makeArchiveFile([makeArchiveTweet('200'), makeArchiveTweet('100')]);
    const fresh = [makeArchiveTweet('300'), makeArchiveTweet('400')];
    const { added } = mergeArchive(existing, fresh, { prune: true, generatedAt: GEN_AT });
    expect(added).toBe(2);
  });

  test('prune: count and newestId are recomputed from fresh', () => {
    const existing = makeArchiveFile([makeArchiveTweet('9999')]);
    const fresh = [makeArchiveTweet('500'), makeArchiveTweet('300')];
    const { file } = mergeArchive(existing, fresh, { prune: true, generatedAt: GEN_AT });
    expect(file.count).toBe(2);
    expect(file.newestId).toBe('500');
  });
});

// ── loadArchive ──────────────────────────────────────────────────────────────

describe('loadArchive', () => {
  test('returns null for a missing file', () => {
    const result = loadArchive('/tmp/does-not-exist-xrelay-test-99999.json');
    expect(result).toBeNull();
  });

  test('returns null for an invalid (non-JSON) file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xrelay-test-'));
    const path = join(dir, 'bad.json');
    // Write invalid JSON
    const { writeFileSync } = require('node:fs');
    writeFileSync(path, 'not json!!!');
    const result = loadArchive(path);
    expect(result).toBeNull();
    rmSync(dir, { recursive: true });
  });

  test('returns null for a file with valid JSON but wrong shape (no schema field)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xrelay-test-'));
    const path = join(dir, 'wrong.json');
    const { writeFileSync } = require('node:fs');
    writeFileSync(path, JSON.stringify({ hello: 'world' }));
    const result = loadArchive(path);
    expect(result).toBeNull();
    rmSync(dir, { recursive: true });
  });
});

// ── saveArchive + loadArchive round-trip ─────────────────────────────────────

describe('saveArchive + loadArchive round-trip', () => {
  test('saves to a new path (creating parent dir) and loads back identical file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xrelay-test-'));
    const path = join(dir, 'sub', 'archive.json');

    const file = makeArchiveFile([makeArchiveTweet('500'), makeArchiveTweet('300')]);
    saveArchive(path, file);

    expect(existsSync(path)).toBe(true);

    const loaded = loadArchive(path);
    expect(loaded).not.toBeNull();
    expect(loaded).toEqual(file);

    rmSync(dir, { recursive: true });
  });

  test('saved file is pretty-printed (contains newlines)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xrelay-test-'));
    const path = join(dir, 'archive.json');

    const file = makeArchiveFile([makeArchiveTweet('100')]);
    saveArchive(path, file);

    const { readFileSync } = require('node:fs');
    const raw = readFileSync(path, 'utf-8');
    expect(raw).toContain('\n');

    rmSync(dir, { recursive: true });
  });
});
