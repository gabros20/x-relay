// Incremental sync into the local cache. Fetches newest-first and early-breaks
// at the stored watermark (snowflake id), so only tweets newer than the last
// sync are pulled — never a full refetch (unless --repair). See ENGINE-RESEARCH §6.
import type { Engine } from '../engine/index.ts';
import { type CacheFile, type CacheSource, loadCache, mergeTweets, saveCache } from './store.ts';

export interface SyncResult {
  source: CacheSource;
  handle?: string;
  added: number;
  total: number;
  watermark?: string;
}

export interface SyncOpts {
  /** Refetch everything and overwrite cached records (repair), ignoring the watermark. */
  repair?: boolean;
  /** Safety cap on how many tweets a single sync will pull. */
  max?: number;
  /** Override the cache directory (tests). */
  dir?: string;
}

const DEFAULT_MAX = 100000;

async function syncInto(
  file: CacheFile,
  fetchPage: (limit: number, stopAtId?: string) => Promise<{ tweets: { id: string }[] }>,
  opts: SyncOpts,
): Promise<SyncResult> {
  const max = opts.max ?? DEFAULT_MAX;
  const stopAtId = opts.repair ? undefined : file.watermark;
  const page = await fetchPage(max, stopAtId);
  const { added } = mergeTweets(file, page.tweets as CacheFile['tweets'][string][]);
  file.syncedAt = new Date().toISOString();
  saveCache(file, opts.dir);
  const result: SyncResult = {
    source: file.source,
    added,
    total: Object.keys(file.tweets).length,
  };
  if (file.handle !== undefined) result.handle = file.handle;
  if (file.watermark !== undefined) result.watermark = file.watermark;
  return result;
}

export function syncBookmarks(engine: Engine, opts: SyncOpts = {}): Promise<SyncResult> {
  const file = loadCache('bookmarks', opts.dir);
  return syncInto(
    file,
    (limit, stopAtId) =>
      engine.bookmarks({ limit, ...(stopAtId !== undefined ? { stopAtId } : {}) }),
    opts,
  );
}

export function syncPosts(
  engine: Engine,
  handle: string | undefined,
  opts: SyncOpts = {},
): Promise<SyncResult> {
  const file = loadCache('posts', opts.dir);
  if (handle) file.handle = handle;
  const h = file.handle;
  if (!h) {
    return Promise.reject(
      new Error('posts sync needs your handle once: `xrelay sync posts --handle <you>`'),
    );
  }
  return syncInto(
    file,
    (limit, stopAtId) =>
      engine.userTweets(h, { limit, ...(stopAtId !== undefined ? { stopAtId } : {}) }),
    opts,
  );
}
