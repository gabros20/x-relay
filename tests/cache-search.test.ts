import { describe, expect, test } from 'bun:test';
import { type CacheSort, searchCache } from '../src/cache/search.ts';
import type { Tweet } from '../src/types.ts';

function tweet(
  id: string,
  text: string,
  opts: {
    handle?: string;
    name?: string;
    likes?: number;
    views?: number;
    bookmarks?: number;
  } = {},
): Tweet {
  return {
    id,
    url: `https://x.com/${opts.handle ?? 'someone'}/status/${id}`,
    text,
    author: {
      id: `u${id}`,
      handle: opts.handle ?? 'someone',
      name: opts.name ?? 'Some One',
      verified: false,
    },
    metrics: {
      likes: opts.likes,
      views: opts.views,
      bookmarks: opts.bookmarks,
    },
  };
}

describe('searchCache', () => {
  test('filters to matching tweets and ranks the better match first', () => {
    const tweets = [
      tweet('100', 'a post about rust and rust again', { name: 'Alice' }),
      tweet('200', 'a single rust mention', { name: 'Bob' }),
      tweet('300', 'nothing relevant here', { name: 'Carol' }),
    ];
    const out = searchCache(tweets, 'rust');
    expect(out.map((t) => t.id)).toEqual(['100', '200']);
  });

  test('a query matching the author handle surfaces that tweet', () => {
    const tweets = [
      tweet('100', 'unrelated text', { handle: 'rustlang', name: 'Rust' }),
      tweet('200', 'also unrelated', { handle: 'someone', name: 'Some One' }),
    ];
    const out = searchCache(tweets, 'rustlang');
    expect(out.map((t) => t.id)).toEqual(['100']);
  });

  test('a query matching the author name surfaces that tweet', () => {
    const tweets = [
      tweet('100', 'unrelated text', { handle: 'jdoe', name: 'Jane Developer' }),
      tweet('200', 'also unrelated', { handle: 'someone', name: 'Some One' }),
    ];
    const out = searchCache(tweets, 'developer');
    expect(out.map((t) => t.id)).toEqual(['100']);
  });

  test('a non-matching query returns an empty array', () => {
    const tweets = [tweet('100', 'hello world'), tweet('200', 'goodbye world')];
    expect(searchCache(tweets, 'zzznope')).toEqual([]);
  });

  test('empty query returns all tweets ordered by relevance tie-break (newest first)', () => {
    const tweets = [tweet('100', 'old'), tweet('300', 'new'), tweet('200', 'mid')];
    const out = searchCache(tweets, '   ');
    expect(out.map((t) => t.id)).toEqual(['300', '200', '100']);
  });

  test("sort:'newest' orders by id desc via BigInt compare (differing lengths)", () => {
    const sort: CacheSort = 'newest';
    const tweets = [
      tweet('99999999999999999', 'short-ish'),
      tweet('1000000000000000000', 'longer id, bigger number'),
      tweet('500000000000000000', 'mid'),
    ];
    const out = searchCache(tweets, '', { sort });
    expect(out.map((t) => t.id)).toEqual([
      '1000000000000000000',
      '500000000000000000',
      '99999999999999999',
    ]);
  });

  test("sort:'oldest' orders by id asc via BigInt compare", () => {
    const tweets = [
      tweet('1000000000000000000', 'a'),
      tweet('99999999999999999', 'b'),
      tweet('500000000000000000', 'c'),
    ];
    const out = searchCache(tweets, '', { sort: 'oldest' });
    expect(out.map((t) => t.id)).toEqual([
      '99999999999999999',
      '500000000000000000',
      '1000000000000000000',
    ]);
  });

  test("sort:'likes' orders by likes desc, missing metric counts as 0", () => {
    const tweets = [
      tweet('100', 'a', { likes: 5 }),
      tweet('200', 'b', { likes: 50 }),
      tweet('300', 'c'),
    ];
    const out = searchCache(tweets, '', { sort: 'likes' });
    expect(out.map((t) => t.id)).toEqual(['200', '100', '300']);
  });

  test("sort:'views' orders by views desc", () => {
    const tweets = [
      tweet('100', 'a', { views: 10 }),
      tweet('200', 'b', { views: 999 }),
      tweet('300', 'c', { views: 100 }),
    ];
    const out = searchCache(tweets, '', { sort: 'views' });
    expect(out.map((t) => t.id)).toEqual(['200', '300', '100']);
  });

  test("sort:'bookmarks' orders by bookmarks desc", () => {
    const tweets = [tweet('100', 'a', { bookmarks: 3 }), tweet('200', 'b', { bookmarks: 8 })];
    const out = searchCache(tweets, '', { sort: 'bookmarks' });
    expect(out.map((t) => t.id)).toEqual(['200', '100']);
  });

  test('non-relevance sort still filters by the query first', () => {
    const tweets = [
      tweet('100', 'rust is great', { likes: 1 }),
      tweet('200', 'rust rocks', { likes: 100 }),
      tweet('300', 'no match', { likes: 999 }),
    ];
    const out = searchCache(tweets, 'rust', { sort: 'likes' });
    expect(out.map((t) => t.id)).toEqual(['200', '100']);
  });

  test('limit caps the result count after filtering+sorting', () => {
    const tweets = [
      tweet('100', 'rust', { likes: 1 }),
      tweet('200', 'rust', { likes: 2 }),
      tweet('300', 'rust', { likes: 3 }),
    ];
    const out = searchCache(tweets, 'rust', { sort: 'likes', limit: 2 });
    expect(out.map((t) => t.id)).toEqual(['300', '200']);
  });

  test('does not mutate the input array', () => {
    const tweets = [tweet('100', 'a'), tweet('300', 'b'), tweet('200', 'c')];
    const before = tweets.map((t) => t.id);
    searchCache(tweets, '', { sort: 'newest' });
    expect(tweets.map((t) => t.id)).toEqual(before);
  });
});
