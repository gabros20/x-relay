// ─── Presentation helpers ─────────────────────────────────────────────────
// Pure functions for ranking and compacting tweets so agents don't burn
// context on full JSON envelopes or hand-rank engagement. No I/O; operates on
// the normalized `Tweet` from src/types.ts. CLI wiring lives in a later task.

import type { Tweet } from './types';

const TEXT_LIMIT = 280;

/** likes + replies*3 + bookmarks*2; missing metrics count as 0. */
export function engagementScore(t: Tweet): number {
  const { likes = 0, replies = 0, bookmarks = 0 } = t.metrics;
  return likes + replies * 3 + bookmarks * 2;
}

/** New array, descending by engagement score, stable for ties. */
export function sortByEngagement(tweets: Tweet[]): Tweet[] {
  return tweets
    .map((t, i) => ({ t, i, score: engagementScore(t) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map(({ t }) => t);
}

/** Flat, context-cheap tweet shape. name omitted when absent; counts default 0. */
export type CompactTweet = {
  id: string;
  url: string;
  handle: string;
  name?: string;
  date?: string;
  text: string;
  likes: number;
  replies: number;
  bookmarks: number;
  views: number;
};

/** Field names of the compact shape — the CLI validates `--fields` against this. */
export const COMPACT_FIELDS = [
  'id',
  'url',
  'handle',
  'name',
  'date',
  'text',
  'likes',
  'replies',
  'bookmarks',
  'views',
] as const;

export type CompactField = (typeof COMPACT_FIELDS)[number];

/**
 * Flatten a tweet: author.handle→handle, author.name→name, createdAt→date,
 * metrics.*→likes/replies/bookmarks/views. Text over 280 chars gets truncated
 * with a trailing ellipsis; the name key is omitted entirely when empty.
 */
export function compactTweet(t: Tweet): CompactTweet {
  const { likes = 0, replies = 0, bookmarks = 0, views = 0 } = t.metrics;
  const compact: CompactTweet = {
    id: t.id,
    url: t.url,
    handle: t.author.handle,
    text:
      [...t.text].length > TEXT_LIMIT ? `${[...t.text].slice(0, TEXT_LIMIT).join('')}…` : t.text,
    likes,
    replies,
    bookmarks,
    views,
  };
  if (t.author.name) compact.name = t.author.name;
  if (t.createdAt) compact.date = t.createdAt;
  return compact;
}

/** Pick a subset of compact keys; unknown field names are silently ignored. */
export function projectFields(t: Tweet, fields: string[]): Partial<CompactTweet> {
  const compact = compactTweet(t);
  const out: Partial<CompactTweet> = {};
  for (const f of fields) {
    if (f in compact) (out as Record<string, unknown>)[f] = (compact as Record<string, unknown>)[f];
  }
  return out;
}
