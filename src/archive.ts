import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { formatIso8601, formatLocal } from './time.ts';
import type { ArchiveFile, ArchiveTweet, Tweet } from './types.ts';

/**
 * Reshape a parsed (rich) Tweet into an ArchiveTweet using xrelay-native naming.
 * - createdAtISO / createdAtLocal are computed from createdAt when present.
 * - media is taken from tweet.mediaItems (omitted when absent).
 * - quoted is recursively converted via toArchiveTweet.
 * - article is passed through as-is.
 * All other fields are passed through directly.
 */
export function toArchiveTweet(tweet: Tweet): ArchiveTweet {
  const result: ArchiveTweet = {
    id: tweet.id,
    url: tweet.url,
    text: tweet.text,
    author: tweet.author,
    metrics: tweet.metrics,
  };

  if (tweet.lang !== undefined) result.lang = tweet.lang;
  if (tweet.createdAt !== undefined) {
    result.createdAt = tweet.createdAt;
    const iso = formatIso8601(tweet.createdAt);
    if (iso !== undefined) result.createdAtISO = iso;
    const local = formatLocal(tweet.createdAt);
    if (local !== undefined) result.createdAtLocal = local;
  }
  if (tweet.hashtags !== undefined) result.hashtags = tweet.hashtags;
  if (tweet.mentions !== undefined) result.mentions = tweet.mentions;
  if (tweet.urls !== undefined) result.urls = tweet.urls;
  if (tweet.mediaItems !== undefined && tweet.mediaItems.length > 0) {
    result.media = tweet.mediaItems;
  }
  if (tweet.isReply !== undefined) result.isReply = tweet.isReply;
  if (tweet.isRetweet !== undefined) result.isRetweet = tweet.isRetweet;
  if (tweet.isQuote !== undefined) result.isQuote = tweet.isQuote;
  if (tweet.retweetedBy !== undefined) result.retweetedBy = tweet.retweetedBy;
  if (tweet.conversationId !== undefined) result.conversationId = tweet.conversationId;
  if (tweet.quoted !== undefined) result.quoted = toArchiveTweet(tweet.quoted);
  if (tweet.article !== undefined) result.article = tweet.article;

  return result;
}

/**
 * Read and parse an ArchiveFile from disk.
 * Returns null if the file is missing, unreadable, or has an invalid shape.
 */
export function loadArchive(path: string): ArchiveFile | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as Record<string, unknown>).schema !== 'x-relay/archive@1'
    ) {
      return null;
    }
    return parsed as ArchiveFile;
  } catch {
    return null;
  }
}

/**
 * Write an ArchiveFile to disk as pretty-printed JSON (2-space indent).
 * Creates parent directories as needed.
 */
export function saveArchive(path: string, file: ArchiveFile): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(file, null, 2), 'utf-8');
}

/**
 * Options for mergeArchive.
 */
export interface MergeOptions {
  /** ISO timestamp string to set as generatedAt on the resulting file. */
  generatedAt: string;
  /**
   * When true, replace file.tweets with exactly `fresh` (prune any no-longer-bookmarked
   * tweets). When false (default), prepend fresh ahead of existing with fresh winning on
   * dedup.
   */
  prune?: boolean;
}

/**
 * Merge fresh ArchiveTweets into an existing ArchiveFile (or create one from scratch).
 *
 * Default (no prune):
 *   - Prepend fresh tweets (newest-first) ahead of existing.tweets.
 *   - Dedup by id: fresh entry wins (drops the older dup from existing).
 *   - Recomputes count and newestId.
 *
 * With prune:
 *   - Replace file.tweets with exactly `fresh` (wholesale replacement).
 *
 * generatedAt is taken from opts.generatedAt and is never derived from Date.now()
 * so this function stays pure/testable.
 */
export function mergeArchive(
  existing: ArchiveFile | null,
  fresh: ArchiveTweet[],
  opts: MergeOptions,
): { file: ArchiveFile; added: number } {
  const { generatedAt, prune = false } = opts;

  let tweets: ArchiveTweet[];
  let added: number;

  if (prune) {
    tweets = fresh;
    added = fresh.length;
  } else {
    const existingTweets = existing?.tweets ?? [];
    const existingIds = new Set(existingTweets.map((t) => t.id));
    const freshIds = new Set(fresh.map((t) => t.id));

    // Count truly new ids (not in existing before merge)
    added = fresh.filter((t) => !existingIds.has(t.id)).length;

    // Build merged list: fresh first (all of them), then existing minus any duplicated by fresh
    const tail = existingTweets.filter((t) => !freshIds.has(t.id));
    tweets = [...fresh, ...tail];
  }

  // Recompute newestId using BigInt comparison for correct snowflake ordering
  let newestId: string | undefined;
  for (const t of tweets) {
    if (newestId === undefined || BigInt(t.id) > BigInt(newestId)) {
      newestId = t.id;
    }
  }

  const file: ArchiveFile = {
    schema: 'x-relay/archive@1',
    source: 'bookmarks',
    generatedAt,
    count: tweets.length,
    ...(newestId !== undefined ? { newestId } : {}),
    tweets,
  };

  return { file, added };
}
