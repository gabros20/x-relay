// Pure keyword + metadata ranking over locally-cached tweets — the offline
// search for the user's bookmarks/posts cache. No I/O, no network.

import type { Tweet } from '../types.ts';

export type CacheSort = 'relevance' | 'newest' | 'oldest' | 'likes' | 'views' | 'bookmarks';

type Scored = { tweet: Tweet; score: number };

const DEFAULT_LIMIT = 20;

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    count += 1;
    from = idx + needle.length;
  }
  return count;
}

function scoreTweet(tweet: Tweet, tokens: string[]): number {
  const haystack = `${tweet.text} ${tweet.author.handle} ${tweet.author.name}`.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    score += countOccurrences(haystack, token);
  }
  return score;
}

/** BigInt compare of snowflake ids; returns negative/zero/positive. */
function compareIds(a: string, b: string): number {
  const ai = BigInt(a);
  const bi = BigInt(b);
  if (ai < bi) return -1;
  if (ai > bi) return 1;
  return 0;
}

function metric(tweet: Tweet, key: 'likes' | 'views' | 'bookmarks'): number {
  return tweet.metrics[key] ?? 0;
}

function comparator(sort: CacheSort): (a: Scored, b: Scored) => number {
  switch (sort) {
    case 'newest':
      return (a, b) => compareIds(b.tweet.id, a.tweet.id);
    case 'oldest':
      return (a, b) => compareIds(a.tweet.id, b.tweet.id);
    case 'likes':
      return (a, b) => metric(b.tweet, 'likes') - metric(a.tweet, 'likes');
    case 'views':
      return (a, b) => metric(b.tweet, 'views') - metric(a.tweet, 'views');
    case 'bookmarks':
      return (a, b) => metric(b.tweet, 'bookmarks') - metric(a.tweet, 'bookmarks');
    default:
      // relevance: score desc, tie-broken by newest id.
      return (a, b) => b.score - a.score || compareIds(b.tweet.id, a.tweet.id);
  }
}

/**
 * Rank locally-cached tweets by keyword relevance and/or a metadata sort.
 * Pure and non-mutating. With query tokens, tweets scoring 0 are excluded.
 */
export function searchCache(
  tweets: Tweet[],
  query: string,
  opts: { limit?: number; sort?: CacheSort } = {},
): Tweet[] {
  const tokens = tokenize(query);
  const sort = opts.sort ?? 'relevance';
  const limit = opts.limit ?? DEFAULT_LIMIT;

  const scored: Scored[] = [];
  for (const tweet of tweets) {
    const score = scoreTweet(tweet, tokens);
    if (tokens.length > 0 && score === 0) continue;
    scored.push({ tweet, score });
  }

  scored.sort(comparator(sort));

  return scored.slice(0, limit).map((s) => s.tweet);
}
