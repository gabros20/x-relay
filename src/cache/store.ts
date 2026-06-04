// Local persistence for the user's cached X posts/bookmarks under ~/.xrelay.
// A small atomic-ish JSON store keyed by tweet id, with a snowflake watermark
// (highest cached id) to drive incremental sync. Never throws on read.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Tweet } from '../types.ts';

export type CacheSource = 'bookmarks' | 'posts';

export interface CacheFile {
  source: CacheSource;
  handle?: string;
  syncedAt?: string;
  /** The highest (newest) tweet id cached. */
  watermark?: string;
  /** Tweets keyed by tweet id. */
  tweets: Record<string, Tweet>;
}

/** The cache directory: an explicit override, else ~/.xrelay. */
export function cacheDir(): string {
  return process.env.XRELAY_CACHE_DIR ?? join(homedir(), '.xrelay');
}

/** The JSON file path for a given source. */
export function cachePath(source: CacheSource, dir?: string): string {
  return join(dir ?? cacheDir(), `${source}.json`);
}

/** Read+parse the cache file; on missing OR unparseable, return a fresh shape. */
export function loadCache(source: CacheSource, dir?: string): CacheFile {
  try {
    const raw = readFileSync(cachePath(source, dir), 'utf8');
    return JSON.parse(raw) as CacheFile;
  } catch {
    return { source, tweets: {} };
  }
}

/** Write the cache as pretty JSON, atomically (temp file then rename). */
export function saveCache(file: CacheFile, dir?: string): void {
  const target = cachePath(file.source, dir);
  mkdirSync(dir ?? cacheDir(), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`);
  renameSync(tmp, target);
}

/** True if `a` is a higher (newer) snowflake id than `b`. */
function isHigherId(a: string, b: string): boolean {
  try {
    return BigInt(a) > BigInt(b);
  } catch {
    if (a.length !== b.length) return a.length > b.length;
    return a > b;
  }
}

/**
 * Merge fresh tweets into the file (overwriting existing ids — repair use case),
 * counting only previously-absent ids as `added`, then recompute the watermark
 * as the max id across ALL cached tweets. Mutates `file`.
 */
export function mergeTweets(file: CacheFile, fresh: Tweet[]): { added: number } {
  let added = 0;
  for (const t of fresh) {
    if (!(t.id in file.tweets)) added += 1;
    file.tweets[t.id] = t;
  }

  let watermark: string | undefined;
  for (const id of Object.keys(file.tweets)) {
    if (watermark === undefined || isHigherId(id, watermark)) watermark = id;
  }
  if (watermark !== undefined) file.watermark = watermark;

  return { added };
}

/** All cached tweets as an array. */
export function allTweets(file: CacheFile): Tweet[] {
  return Object.values(file.tweets);
}
