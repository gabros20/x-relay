// Command runners — thin adapters from parsed options to Engine calls, each
// returning a JSON envelope. Network/transport errors (EngineError) become
// clean error envelopes; the runners hold no business logic of their own.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadArchive, mergeArchive, saveArchive } from '../archive.ts';
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
import { parseTwitterDateMs } from '../time.ts';
import type {
  ArchiveFile,
  ArchiveTweet,
  BookmarkFolder,
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

// ── destructive-write confirmation guard (convention for T8–T10) ─────────────
//
// CONVENTION: every destructive write command (delete-tweet, unfollow, …) takes a
// `confirmed` flag in its opts and, as its FIRST step, calls requireConfirmation.
// Without `confirmed: true` the runner returns a CONFIRMATION_REQUIRED error
// envelope and performs NO network call — so a destructive action never fires by
// accident from the CLI / MCP surface. The actual delete command lands in T10;
// T7 only establishes the convention + this helper. Non-destructive writes
// (like / bookmark / retweet) do NOT need confirmation.

/** Opts mixin: destructive write runners extend this so `confirmed` is uniform. */
export interface ConfirmableOpts {
  /** Must be explicitly true for a destructive write to proceed. */
  confirmed?: boolean;
}

/**
 * Gate a destructive write on an explicit confirmation. Returns a
 * CONFIRMATION_REQUIRED error envelope when `confirmed` is not true, otherwise
 * null (proceed). Usage:
 *
 *   const block = requireConfirmation('delete-tweet', opts, 'permanently delete tweet 20');
 *   if (block) return block;
 *   return guard('delete-tweet', () => engine.mutate('DeleteTweet', { tweet_id }));
 */
export function requireConfirmation(
  command: string,
  opts: ConfirmableOpts,
  action: string,
): Envelope<never> | null {
  if (opts.confirmed === true) return null;
  return err(
    command,
    'CONFIRMATION_REQUIRED',
    `Refusing to ${action} without confirmation.`,
    'Re-run with --confirm (or pass confirmed: true) to proceed.',
  );
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

export function runWhoami(engine: Engine): Promise<Envelope<UserProfile>> {
  return guard('whoami', async () => {
    const profile = await engine.whoami();
    if (!profile) throw new EngineError('NOT_FOUND', 'not logged in');
    return profile;
  });
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

export function runLikes(engine: Engine, handle: string | undefined, limit?: number) {
  return guard('likes', async () => {
    const resolvedHandle = handle || (await engine.me());
    if (!resolvedHandle)
      throw new EngineError('INVALID_INPUT', 'could not determine your handle — pass a handle');
    return engine.likes(resolvedHandle, lim(limit));
  });
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

export function runFeed(engine: Engine, opts: { following?: boolean; limit?: number }) {
  return guard('feed', () =>
    engine.feed({
      ...(opts.following ? { following: true } : {}),
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

/**
 * Run the bookmarks folders command.
 * Without folderId: returns the folder list as `{ folders: BookmarkFolder[] }`.
 * With folderId: returns the folder's tweet timeline as a TweetPage.
 */
export function runBookmarkFolders(
  engine: Engine,
  folderId?: string,
  limit?: number,
): Promise<Envelope<{ folders: BookmarkFolder[] } | TweetPage>> {
  if (folderId) {
    return guard('bookmark-folders', () => engine.folderTimeline(folderId, lim(limit)));
  }
  return guard('bookmark-folders', async () => {
    const folders = await engine.bookmarkFolders();
    return { folders };
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

// ── archive ──────────────────────────────────────────────────────────────────

export interface ArchiveCommandOpts extends Partial<SearchQueryFlags> {
  /** The archive sub-target: bookmarks | user | my-posts | list | search | likes | feed. */
  target: string;
  /** Output file path. Required unless --stdout. */
  out?: string;
  /** Maximum number of tweets to fetch this run. */
  limit?: number;
  /** When true, ignore knownIds and page up to limit (full rebuild). */
  full?: boolean;
  /** When true with full, replace the file with exactly the current bookmark set. */
  prune?: boolean;
  /** When true, print the archive JSON to stdout instead of saving to disk. */
  stdout?: boolean;
  /** For user target: the @handle to archive. */
  handle?: string;
  /** For user / my-posts targets: include replies in the sweep. */
  replies?: boolean;
  // query?: string is inherited from Partial<SearchQueryFlags> — no re-declaration needed.
  /** For search target: the search product / tab (default: 'Top'). */
  product?: SearchProduct;
  /** For list target: the Twitter List id to archive. */
  listId?: string;
  /** For bookmarks target: when set, archive from this specific bookmark folder id. */
  folderId?: string;
  /** For feed target: when true, fetch the following (chronological) timeline. */
  following?: boolean;
}

export interface ArchiveResult {
  source: 'bookmarks' | 'user' | 'my-posts' | 'list' | 'search' | 'likes' | 'feed';
  /** Path the file was written to (undefined when --stdout). */
  out?: string;
  /** For user / my-posts sources: the target @handle. */
  handle?: string;
  /** Number of newly added tweets (not in the prior archive). */
  added: number;
  /** Total tweets in the resulting archive. */
  total: number;
  /** Max tweet id in the resulting archive. */
  newestId?: string;
}

/**
 * The provenance + behavior a specific archive target supplies to runArchiveCore.
 */
interface ArchiveSpec {
  /** Source label written to both the ArchiveFile and the ArchiveResult. */
  source: ArchiveResult['source'];
  /**
   * Fetch the fresh tweets for this target. `knownIds` is provided for incremental
   * (membership-stop) runs and is undefined on a full run.
   */
  fetch: (knownIds: Set<string> | undefined) => Promise<ArchiveTweet[]>;
  /**
   * Optional hook to stamp target-specific provenance onto the merged file
   * (handle / query / listId). Runs after mergeArchive, before save/stdout.
   */
  patchFile?: (file: ArchiveFile) => void;
  /** Optional @handle to surface on the ArchiveResult (user / my-posts). */
  handle?: string;
}

/**
 * Shared scaffolding for every archive target: load existing → derive knownIds
 * (unless full) → fetch fresh → merge → patch provenance → stdout-or-save →
 * build the ArchiveResult envelope payload. Targets supply only their fetch
 * closure + provenance via ArchiveSpec, so T2–T6 become one-liners.
 */
async function runArchiveCore(opts: ArchiveCommandOpts, spec: ArchiveSpec): Promise<ArchiveResult> {
  const outPath = opts.out;

  // Load existing archive to derive knownIds for the incremental membership stop.
  const existing = outPath ? loadArchive(outPath) : null;
  const knownIds = !opts.full && existing ? new Set(existing.tweets.map((t) => t.id)) : undefined;

  let fresh = await spec.fetch(knownIds);

  // --since YYYY-MM-DD post-filter: drop tweets older than the cutoff date
  // (start-of-day UTC, inclusive boundary). Applies uniformly to ALL targets
  // so every target inherits it from this shared core.
  // Tweets with an unparseable / absent createdAt are KEPT (fail-open).
  if (opts.since) {
    const cutoffMs = Date.parse(`${opts.since}T00:00:00Z`);
    if (!Number.isNaN(cutoffMs)) {
      fresh = fresh.filter((t) => {
        const tweetMs = t.createdAt !== undefined ? parseTwitterDateMs(t.createdAt) : undefined;
        // Keep when we cannot determine the date (fail-open).
        if (tweetMs === undefined) return true;
        return tweetMs >= cutoffMs;
      });
    }
  }

  const generatedAt = new Date().toISOString();
  const { file, added } = mergeArchive(existing, fresh, {
    generatedAt,
    ...(opts.prune ? { prune: true } : {}),
  });

  file.source = spec.source;
  spec.patchFile?.(file);

  if (opts.stdout) {
    process.stdout.write(JSON.stringify(file, null, 2));
  } else if (outPath) {
    saveArchive(outPath, file);
  }

  return {
    source: spec.source,
    ...(spec.handle !== undefined ? { handle: spec.handle } : {}),
    ...(outPath ? { out: outPath } : {}),
    added,
    total: file.count,
    ...(file.newestId !== undefined ? { newestId: file.newestId } : {}),
  };
}

/** Engine-opts shared by all timeline archive fetches (limit/full/knownIds). */
function archiveFetchOpts(
  opts: ArchiveCommandOpts,
  knownIds: Set<string> | undefined,
): { knownIds?: Set<string>; full?: true; limit?: number } {
  return {
    ...(knownIds !== undefined ? { knownIds } : {}),
    ...(opts.full ? { full: true } : {}),
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
  };
}

/** Run the bookmarks archive path and return an ArchiveResult. */
function runArchiveBookmarks(engine: Engine, opts: ArchiveCommandOpts): Promise<ArchiveResult> {
  const folderId = opts.folderId;
  if (folderId) {
    return runArchiveCore(opts, {
      source: 'bookmarks',
      patchFile: (file) => {
        file.folderId = folderId;
      },
      fetch: (knownIds) => engine.archiveBookmarkFolder(folderId, archiveFetchOpts(opts, knownIds)),
    });
  }
  return runArchiveCore(opts, {
    source: 'bookmarks',
    fetch: (knownIds) => engine.archiveBookmarks(archiveFetchOpts(opts, knownIds)),
  });
}

/** Run the user-posts archive path and return an ArchiveResult. */
function runArchiveUser(engine: Engine, opts: ArchiveCommandOpts): Promise<ArchiveResult> {
  const handle = opts.handle;
  if (!handle) throw new EngineError('INVALID_INPUT', 'archive user requires a handle');
  return runArchiveCore(opts, {
    source: 'user',
    handle,
    patchFile: (file) => {
      file.handle = handle;
    },
    fetch: (knownIds) =>
      engine.archiveUserPosts(handle, {
        ...archiveFetchOpts(opts, knownIds),
        ...(opts.replies ? { replies: true } : {}),
      }),
  });
}

/** Run the my-posts archive path and return an ArchiveResult. */
async function runArchiveMyPosts(engine: Engine, opts: ArchiveCommandOpts): Promise<ArchiveResult> {
  // Resolve self handle for provenance; me() is memoized so this adds no extra
  // network call beyond the one archiveMyPosts already makes.
  const handle = (await engine.me()) ?? undefined;
  return runArchiveCore(opts, {
    source: 'my-posts',
    ...(handle !== undefined ? { handle } : {}),
    ...(handle !== undefined
      ? {
          patchFile: (file: ArchiveFile) => {
            file.handle = handle;
          },
        }
      : {}),
    fetch: (knownIds) =>
      engine.archiveMyPosts({
        ...archiveFetchOpts(opts, knownIds),
        ...(opts.replies ? { replies: true } : {}),
      }),
  });
}

/** Run the likes archive path and return an ArchiveResult. Defaults handle to self via me(). */
async function runArchiveLikes(engine: Engine, opts: ArchiveCommandOpts): Promise<ArchiveResult> {
  const handle = opts.handle ?? (await engine.me()) ?? undefined;
  if (!handle) throw new EngineError('INVALID_INPUT', 'could not determine handle — pass a handle');
  return runArchiveCore(opts, {
    source: 'likes',
    handle,
    patchFile: (file) => {
      file.handle = handle;
    },
    fetch: (knownIds) => engine.archiveLikes(handle, archiveFetchOpts(opts, knownIds)),
  });
}

export function runArchive(
  engine: Engine,
  opts: ArchiveCommandOpts,
): Promise<Envelope<ArchiveResult>> {
  // Output destination is required for every target, so validate before dispatch.
  if (!opts.stdout && !opts.out) {
    return Promise.resolve(
      err('archive', 'INVALID_INPUT', 'provide --out <file.json> or --stdout'),
    );
  }

  switch (opts.target) {
    case 'bookmarks':
      return guard('archive', () => runArchiveBookmarks(engine, opts));

    case 'user':
      return guard('archive', () => runArchiveUser(engine, opts));

    case 'my-posts':
      return guard('archive', () => runArchiveMyPosts(engine, opts));

    case 'search': {
      const rawQuery = buildSearchQuery({ query: opts.query ?? '', ...opts });
      if (!rawQuery)
        return Promise.resolve(err('archive', 'INVALID_INPUT', 'archive search requires a query'));
      return guard('archive', () =>
        runArchiveCore(opts, {
          source: 'search',
          patchFile: (file) => {
            file.query = rawQuery;
          },
          fetch: (knownIds) =>
            engine.archiveSearch(rawQuery, {
              ...archiveFetchOpts(opts, knownIds),
              ...(opts.product ? { product: opts.product } : {}),
            }),
        }),
      );
    }

    case 'list': {
      const listId = opts.listId;
      if (!listId)
        return Promise.resolve(err('archive', 'INVALID_INPUT', 'archive list requires a list id'));
      return guard('archive', () =>
        runArchiveCore(opts, {
          source: 'list',
          patchFile: (file) => {
            file.listId = listId;
          },
          fetch: (knownIds) => engine.archiveList(listId, archiveFetchOpts(opts, knownIds)),
        }),
      );
    }

    case 'likes':
      return guard('archive', () => runArchiveLikes(engine, opts));

    case 'feed':
      return guard('archive', () =>
        runArchiveCore(opts, {
          source: 'feed',
          fetch: (_knownIds) =>
            engine.archiveFeed({
              // Feed is not id-monotonic; membership-stop is intentionally disabled
              // (same as archiveSearch). knownIds is ignored — always full sweep.
              ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
              ...(opts.following ? { following: true } : {}),
              full: true,
            }),
        }),
      );

    default:
      return Promise.resolve(
        err('archive', 'INVALID_INPUT', `unknown archive target: ${opts.target}`),
      );
  }
}

// ── write: post / reply / quote ──────────────────────────────────────────────

/** Result returned by the post / reply / quote runners. */
export interface PostResult {
  id: string;
  url: string;
}

/**
 * Post a new tweet.
 * `text` must be non-empty — runners never post blank content automatically.
 */
export function runPost(engine: Engine, text: string): Promise<Envelope<PostResult>> {
  if (!text || !text.trim())
    return Promise.resolve(err('post', 'INVALID_INPUT', 'tweet text must not be empty'));
  return guard('post', () => engine.post(text));
}

/**
 * Reply to an existing tweet.
 * Both `tweetId` and `text` must be present.
 */
export function runReply(
  engine: Engine,
  tweetId: string,
  text: string,
): Promise<Envelope<PostResult>> {
  if (!tweetId) return Promise.resolve(err('reply', 'INVALID_INPUT', 'missing tweet id/url'));
  if (!text || !text.trim())
    return Promise.resolve(err('reply', 'INVALID_INPUT', 'reply text must not be empty'));
  return guard('reply', () => engine.post(text, { replyToId: tweetId }));
}

/**
 * Quote-tweet an existing tweet.
 * Both `tweetId` and `text` must be present.
 */
export function runQuote(
  engine: Engine,
  tweetId: string,
  text: string,
): Promise<Envelope<PostResult>> {
  if (!tweetId) return Promise.resolve(err('quote', 'INVALID_INPUT', 'missing tweet id/url'));
  if (!text || !text.trim())
    return Promise.resolve(err('quote', 'INVALID_INPUT', 'quote text must not be empty'));
  return guard('quote', () => engine.post(text, { quoteTweetId: tweetId }));
}

// ── write: like / unlike / bookmark / unbookmark ────────────────────────────

/** Result returned by the like / unlike / bookmark / unbookmark runners. */
export interface ToggleResult {
  tweetId: string;
  action:
    | 'liked'
    | 'unliked'
    | 'bookmarked'
    | 'unbookmarked'
    | 'retweeted'
    | 'unretweeted'
    | 'deleted';
}

/** Result returned by the follow / unfollow runners. */
export interface FollowResult {
  handle: string;
  action: 'followed' | 'unfollowed';
}

/**
 * Like a tweet.
 * Returns INVALID_INPUT when `tweetId` is empty.
 * ALREADY_DONE from the engine surfaces as an error envelope via guard().
 */
export function runLike(engine: Engine, tweetId: string): Promise<Envelope<ToggleResult>> {
  if (!tweetId) return Promise.resolve(err('like', 'INVALID_INPUT', 'missing tweet id'));
  return guard('like', async () => {
    await engine.like(tweetId);
    return { tweetId, action: 'liked' as const };
  });
}

/**
 * Unlike a tweet.
 * Returns INVALID_INPUT when `tweetId` is empty.
 * ALREADY_DONE from the engine surfaces as an error envelope via guard().
 */
export function runUnlike(engine: Engine, tweetId: string): Promise<Envelope<ToggleResult>> {
  if (!tweetId) return Promise.resolve(err('unlike', 'INVALID_INPUT', 'missing tweet id'));
  return guard('unlike', async () => {
    await engine.unlike(tweetId);
    return { tweetId, action: 'unliked' as const };
  });
}

/**
 * Bookmark a tweet.
 * Returns INVALID_INPUT when `tweetId` is empty.
 * ALREADY_DONE from the engine surfaces as an error envelope via guard().
 * Note: this is the write operation — the read/cache command is `runBookmarks` (plural).
 */
export function runBookmarkAdd(engine: Engine, tweetId: string): Promise<Envelope<ToggleResult>> {
  if (!tweetId) return Promise.resolve(err('bookmark', 'INVALID_INPUT', 'missing tweet id'));
  return guard('bookmark', async () => {
    await engine.bookmark(tweetId);
    return { tweetId, action: 'bookmarked' as const };
  });
}

/**
 * Remove a bookmark.
 * Returns INVALID_INPUT when `tweetId` is empty.
 * ALREADY_DONE from the engine surfaces as an error envelope via guard().
 */
export function runUnbookmark(engine: Engine, tweetId: string): Promise<Envelope<ToggleResult>> {
  if (!tweetId) return Promise.resolve(err('unbookmark', 'INVALID_INPUT', 'missing tweet id'));
  return guard('unbookmark', async () => {
    await engine.unbookmark(tweetId);
    return { tweetId, action: 'unbookmarked' as const };
  });
}

/**
 * Retweet a tweet.
 * Returns INVALID_INPUT when `tweetId` is empty.
 * ALREADY_DONE from the engine surfaces as an error envelope via guard().
 */
export function runRetweet(engine: Engine, tweetId: string): Promise<Envelope<ToggleResult>> {
  if (!tweetId) return Promise.resolve(err('retweet', 'INVALID_INPUT', 'missing tweet id'));
  return guard('retweet', async () => {
    await engine.retweet(tweetId);
    return { tweetId, action: 'retweeted' as const };
  });
}

/**
 * Undo a retweet.
 * Returns INVALID_INPUT when `tweetId` is empty.
 * ALREADY_DONE from the engine surfaces as an error envelope via guard().
 */
export function runUnretweet(engine: Engine, tweetId: string): Promise<Envelope<ToggleResult>> {
  if (!tweetId) return Promise.resolve(err('unretweet', 'INVALID_INPUT', 'missing tweet id'));
  return guard('unretweet', async () => {
    await engine.unretweet(tweetId);
    return { tweetId, action: 'unretweeted' as const };
  });
}

/**
 * Permanently delete a tweet.
 * DESTRUCTIVE — requires explicit confirmation via the `requireConfirmation` guard.
 * Without `opts.confirmed === true` returns a CONFIRMATION_REQUIRED envelope and
 * performs NO network call. Only when confirmed does it call engine.deleteTweet().
 *
 * @param tweetId  The snowflake id of the tweet to delete.
 * @param opts     Must include `confirmed: true` to proceed.
 */
export function runDelete(
  engine: Engine,
  tweetId: string,
  opts: ConfirmableOpts,
): Promise<Envelope<ToggleResult>> {
  if (!tweetId) return Promise.resolve(err('delete', 'INVALID_INPUT', 'missing tweet id'));
  const block = requireConfirmation('delete', opts, `delete tweet ${tweetId}`);
  if (block) return Promise.resolve(block);
  return guard('delete', async () => {
    await engine.deleteTweet(tweetId);
    return { tweetId, action: 'deleted' as const };
  });
}

/**
 * Follow a user.
 * Returns INVALID_INPUT when `handle` is empty.
 * NOT_FOUND from the engine surfaces as an error envelope via guard().
 */
export function runFollow(engine: Engine, handle: string): Promise<Envelope<FollowResult>> {
  if (!handle) return Promise.resolve(err('follow', 'INVALID_INPUT', 'missing handle'));
  return guard('follow', async () => {
    await engine.follow(handle);
    return { handle, action: 'followed' as const };
  });
}

/**
 * Unfollow a user.
 * Returns INVALID_INPUT when `handle` is empty.
 * NOT_FOUND from the engine surfaces as an error envelope via guard().
 */
export function runUnfollow(engine: Engine, handle: string): Promise<Envelope<FollowResult>> {
  if (!handle) return Promise.resolve(err('unfollow', 'INVALID_INPUT', 'missing handle'));
  return guard('unfollow', async () => {
    await engine.unfollow(handle);
    return { handle, action: 'unfollowed' as const };
  });
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
