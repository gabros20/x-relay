// Command runners — thin adapters from parsed options to Engine calls, each
// returning a JSON envelope. Network/transport errors (EngineError) become
// clean error envelopes; the runners hold no business logic of their own.
import {
  type CacheSort,
  type CacheSource,
  type SyncResult,
  allTweets,
  loadCache,
  searchCache,
  syncBookmarks,
  syncPosts,
} from '../cache/index.ts';
import { type Engine, EngineError } from '../engine/index.ts';
import type { SearchProduct } from '../engine/ops.ts';
import { err, ok } from '../output.ts';
import type {
  Envelope,
  SearchResult,
  ThreadResult,
  Tweet,
  TweetPage,
  UserProfile,
} from '../types.ts';
import { type SearchQueryFlags, buildSearchQuery } from './query.ts';

/** Run an engine call, mapping EngineError (and anything else) to an error envelope. */
async function guard<T>(command: string, fn: () => Promise<T>): Promise<Envelope<T>> {
  try {
    return ok(command, await fn());
  } catch (e) {
    if (e instanceof EngineError) {
      const hint =
        e.code === 'AUTH_FAILED'
          ? 'Re-log into x.com in your browser, or set XRELAY_COOKIES.'
          : e.code === 'FEATURE_DRIFT'
            ? 'X rotated its API; refresh the query-ids/features in src/engine/ops.ts.'
            : undefined;
      return err(command, e.code, e.message, hint);
    }
    return err(command, 'FETCH_FAILED', e instanceof Error ? e.message : String(e));
  }
}

export interface SearchCommandOpts extends Omit<SearchQueryFlags, 'query'> {
  query: string;
  limit?: number;
  product?: SearchProduct;
}

export function runSearch(
  engine: Engine,
  opts: SearchCommandOpts,
): Promise<Envelope<SearchResult>> {
  const raw = buildSearchQuery(opts);
  if (!raw) return Promise.resolve(err('search', 'INVALID_INPUT', 'empty query'));
  return guard('search', () =>
    engine.search(raw, {
      ...(opts.product ? { product: opts.product } : {}),
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    }),
  );
}

export function runUser(engine: Engine, handle: string): Promise<Envelope<UserProfile | null>> {
  if (!handle) return Promise.resolve(err('user', 'INVALID_INPUT', 'missing handle'));
  return guard('user', () => engine.user(handle));
}

export interface UserPostsCommandOpts {
  handle: string;
  replies?: boolean;
  limit?: number;
}

export function runUserPosts(
  engine: Engine,
  opts: UserPostsCommandOpts,
): Promise<Envelope<TweetPage>> {
  if (!opts.handle) return Promise.resolve(err('user-posts', 'INVALID_INPUT', 'missing handle'));
  return guard('user-posts', () =>
    engine.userTweets(opts.handle, {
      ...(opts.replies ? { replies: true } : {}),
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    }),
  );
}

export function runThread(engine: Engine, id: string): Promise<Envelope<ThreadResult>> {
  if (!id) return Promise.resolve(err('thread', 'INVALID_INPUT', 'missing tweet id/url'));
  return guard('thread', () => engine.thread(id));
}

// ── cache-backed: bookmarks + my-posts ──────────────────────────────────────

export interface CacheViewOpts {
  query?: string;
  limit?: number;
  sort?: CacheSort;
  /** Hit X directly instead of the local cache. */
  live?: boolean;
  /** Refresh the cache (incremental) before reading. */
  sync?: boolean;
  /** With sync: refetch everything and patch records. */
  repair?: boolean;
  /** With sync: cap how many tweets to pull this run. */
  max?: number;
}

function syncOpts(opts: { repair?: boolean; max?: number }): { repair?: boolean; max?: number } {
  return {
    ...(opts.repair ? { repair: true } : {}),
    ...(opts.max !== undefined ? { max: opts.max } : {}),
  };
}

export interface CacheView {
  source: CacheSource;
  cached: boolean;
  total?: number;
  syncedAt?: string;
  added?: number;
  tweets: Tweet[];
  hint?: string;
}

export function runBookmarks(
  engine: Engine,
  opts: CacheViewOpts = {},
): Promise<Envelope<CacheView | TweetPage>> {
  if (opts.live) {
    return guard('bookmarks', () =>
      engine.bookmarks({ ...(opts.limit !== undefined ? { limit: opts.limit } : {}) }),
    );
  }
  return guard('bookmarks', async () => {
    let added: number | undefined;
    if (opts.sync || opts.repair) {
      const r = await syncBookmarks(engine, syncOpts(opts));
      added = r.added;
    }
    return viewCache('bookmarks', opts, added);
  });
}

export interface MyPostsOpts extends CacheViewOpts {
  handle?: string;
}

export function runMyPosts(
  engine: Engine,
  opts: MyPostsOpts = {},
): Promise<Envelope<CacheView | TweetPage>> {
  if (opts.live) {
    if (!opts.handle) {
      return Promise.resolve(err('my-posts', 'INVALID_INPUT', '--live needs --handle <you>'));
    }
    return guard('my-posts', () =>
      engine.userTweets(opts.handle as string, {
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      }),
    );
  }
  return guard('my-posts', async () => {
    let added: number | undefined;
    if (opts.sync || opts.repair) {
      const r = await syncPosts(engine, opts.handle, syncOpts(opts));
      added = r.added;
    }
    return viewCache('posts', opts, added);
  });
}

function viewCache(source: CacheSource, opts: CacheViewOpts, added?: number): CacheView {
  const file = loadCache(source);
  const tweets = searchCache(allTweets(file), opts.query ?? '', {
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    ...(opts.sort ? { sort: opts.sort } : {}),
  });
  const total = Object.keys(file.tweets).length;
  const view: CacheView = { source, cached: true, total, tweets };
  if (file.syncedAt !== undefined) view.syncedAt = file.syncedAt;
  if (added !== undefined) view.added = added;
  if (total === 0) {
    view.hint = `cache is empty — run \`xrelay sync ${source}${source === 'posts' ? ' --handle <you>' : ''}\` first (or pass --live).`;
  }
  return view;
}

// ── sync ────────────────────────────────────────────────────────────────────

export interface SyncCommandOpts {
  source: 'bookmarks' | 'posts' | 'all';
  handle?: string;
  repair?: boolean;
  max?: number;
}

export function runSync(engine: Engine, opts: SyncCommandOpts): Promise<Envelope<SyncResult[]>> {
  const so = syncOpts(opts);
  return guard('sync', async () => {
    const results: SyncResult[] = [];
    if (opts.source === 'bookmarks' || opts.source === 'all') {
      results.push(await syncBookmarks(engine, so));
    }
    if (opts.source === 'posts' || opts.source === 'all') {
      results.push(await syncPosts(engine, opts.handle, so));
    }
    return results;
  });
}
