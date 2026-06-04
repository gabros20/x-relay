// Command runners — thin adapters from parsed options to Engine calls, each
// returning a JSON envelope. Network/transport errors (EngineError) become
// clean error envelopes; the runners hold no business logic of their own.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
  MediaItem,
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

// ── more read endpoints (timelines / users / trends / article / media) ───────

const lim = (n?: number): { limit?: number } => (n !== undefined ? { limit: n } : {});

export function runList(engine: Engine, listId: string, limit?: number) {
  if (!listId) return Promise.resolve(err('list', 'INVALID_INPUT', 'missing list id'));
  return guard('list', () => engine.list(listId, lim(limit)));
}

export function runUserMedia(engine: Engine, handle: string, limit?: number) {
  if (!handle) return Promise.resolve(err('user-media', 'INVALID_INPUT', 'missing handle'));
  return guard('user-media', () => engine.userMedia(handle, lim(limit)));
}

export function runFollowers(engine: Engine, handle: string, limit?: number) {
  if (!handle) return Promise.resolve(err('followers', 'INVALID_INPUT', 'missing handle'));
  return guard('followers', () => engine.followers(handle, lim(limit)));
}

export function runFollowing(engine: Engine, handle: string, limit?: number) {
  if (!handle) return Promise.resolve(err('following', 'INVALID_INPUT', 'missing handle'));
  return guard('following', () => engine.following(handle, lim(limit)));
}

export function runRetweeters(engine: Engine, tweetId: string, limit?: number) {
  if (!tweetId) return Promise.resolve(err('retweeters', 'INVALID_INPUT', 'missing tweet id'));
  return guard('retweeters', () => engine.retweeters(tweetId, lim(limit)));
}

export function runLikers(engine: Engine, tweetId: string, limit?: number) {
  if (!tweetId) return Promise.resolve(err('likers', 'INVALID_INPUT', 'missing tweet id'));
  return guard('likers', () => engine.likers(tweetId, lim(limit)));
}

export function runQuoters(engine: Engine, tweetId: string, limit?: number) {
  if (!tweetId) return Promise.resolve(err('quoters', 'INVALID_INPUT', 'missing tweet id'));
  return guard('quoters', () => engine.quoters(tweetId, lim(limit)));
}

export function runTrends(engine: Engine, opts: { woeid?: number; limit?: number } = {}) {
  return guard('trends', () =>
    engine.trends({
      ...(opts.woeid !== undefined ? { woeid: opts.woeid } : {}),
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    }),
  );
}

export function runCommunity(engine: Engine, communityId: string, limit?: number) {
  if (!communityId)
    return Promise.resolve(err('community', 'INVALID_INPUT', 'missing community id'));
  return guard('community', () => engine.community(communityId, lim(limit)));
}

export function runCommunityInfo(engine: Engine, communityId: string) {
  if (!communityId)
    return Promise.resolve(err('community-info', 'INVALID_INPUT', 'missing community id'));
  return guard('community-info', async () => {
    const info = await engine.communityInfo(communityId);
    if (!info) throw new EngineError('NOT_FOUND', 'community not found');
    return info;
  });
}

export function runArticle(engine: Engine, tweetId: string) {
  if (!tweetId) return Promise.resolve(err('article', 'INVALID_INPUT', 'missing tweet id/url'));
  return guard('article', async () => {
    const article = await engine.article(tweetId);
    if (!article) throw new EngineError('NOT_FOUND', 'no Article found on that tweet');
    return article;
  });
}

export interface MediaResult {
  tweetId: string;
  media: MediaItem[];
  files?: string[];
}

export function runMedia(engine: Engine, tweetId: string, outDir?: string) {
  if (!tweetId) return Promise.resolve(err('media', 'INVALID_INPUT', 'missing tweet id/url'));
  return guard('media', async () => {
    const media = await engine.media(tweetId);
    const result: MediaResult = { tweetId, media };
    if (outDir && media.length > 0) result.files = await downloadMedia(media, tweetId, outDir);
    return result;
  });
}

async function downloadMedia(media: MediaItem[], id: string, outDir: string): Promise<string[]> {
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const files: string[] = [];
  for (let i = 0; i < media.length; i++) {
    const item = media[i];
    if (!item) continue;
    const ext = item.type === 'photo' ? 'jpg' : 'mp4';
    const path = join(outDir, `${id}-${i}.${ext}`);
    const res = await fetch(item.url);
    writeFileSync(path, Buffer.from(await res.arrayBuffer()));
    files.push(path);
  }
  return files;
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
    return guard('my-posts', async () => {
      const handle = opts.handle ?? (await engine.me());
      if (!handle)
        throw new EngineError('INVALID_INPUT', 'could not determine your handle — pass --handle');
      return engine.userTweets(handle, {
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      });
    });
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
    view.hint = `cache is empty — run \`xrelay sync ${source}\` first (or pass --live).`;
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
