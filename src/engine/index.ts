// The Engine — the only network-facing surface. Wires the transaction-id
// generator + auth headers + op config + request driver + parser into the
// high-level research operations the commands consume. Network lives here so
// command logic stays pure and testable. See docs/ENGINE-RESEARCH.md.
import type {
  Article,
  MediaItem,
  SearchResult,
  ThreadResult,
  Trend,
  Tweet,
  TweetPage,
  UserPage,
  UserProfile,
} from '../types.ts';
import { type Cookies, buildHeaders } from './auth.ts';
import { type ClientResult, type TransactionProvider, createClient } from './client.ts';
import { getCookies } from './cookies.ts';
import {
  type BuiltRequest,
  type OpName,
  type SearchProduct,
  bookmarksRequest,
  listRequest,
  searchRequest,
  tweetDetailRequest,
  tweetResultRequest,
  userByScreenNameRequest,
  userListRequest,
  userMediaRequest,
  userTweetsRequest,
} from './ops.ts';
import { extractTweetMedia, parseArticle, parseUserTimeline } from './parse-extra.ts';
import { findDict, parseThread, parseTimeline, parseUserResult } from './parse.ts';
import { ClientTransaction, handleXMigration } from './xctid/index.ts';

const DEFAULT_LIMIT = 40;
/** Stop paginating after this many consecutive pages with no fresh tweets. */
const EMPTY_PAGE_TOLERANCE = 3;

/** A failure surfaced from the network/transport layer. Commands map it to an envelope. */
export class EngineError extends Error {
  readonly code: string;
  readonly status?: number;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

/** The transport surface the engine needs — satisfied by createClient, fakeable in tests. */
export interface EngineClient {
  get(op: OpName, request: BuiltRequest): Promise<ClientResult>;
}

export interface SearchOpts {
  product?: SearchProduct;
  limit?: number;
}

export interface UserTweetsOpts {
  replies?: boolean;
  limit?: number;
  /** Stop paginating once a tweet with id <= this is seen (incremental sync watermark). */
  stopAtId?: string;
}

export interface PageOpts {
  limit?: number;
  /** Stop paginating once a tweet with id <= this is seen (incremental sync watermark). */
  stopAtId?: string;
}

/** Snowflake ids are time-ordered; compare as BigInt, falling back to string length/compare. */
function idLte(a: string, b: string): boolean {
  try {
    return BigInt(a) <= BigInt(b);
  } catch {
    return a.length === b.length ? a <= b : a.length < b.length;
  }
}

export interface Engine {
  search(query: string, opts?: SearchOpts): Promise<SearchResult>;
  user(handle: string): Promise<UserProfile | null>;
  userTweets(handle: string, opts?: UserTweetsOpts): Promise<TweetPage>;
  userMedia(handle: string, opts?: PageOpts): Promise<TweetPage>;
  bookmarks(opts?: PageOpts): Promise<TweetPage>;
  thread(id: string): Promise<ThreadResult>;
  list(listId: string, opts?: PageOpts): Promise<TweetPage>;
  followers(handle: string, opts?: PageOpts): Promise<UserPage>;
  following(handle: string, opts?: PageOpts): Promise<UserPage>;
  retweeters(tweetId: string, opts?: PageOpts): Promise<UserPage>;
  likers(tweetId: string, opts?: PageOpts): Promise<UserPage>;
  quoters(tweetId: string, opts?: SearchOpts): Promise<SearchResult>;
  trends(opts?: { woeid?: number; limit?: number }): Promise<Trend[]>;
  article(tweetId: string): Promise<Article | null>;
  media(tweetId: string): Promise<MediaItem[]>;
  /** The authenticated user's own @handle (from the session), or null. Memoized. */
  me(): Promise<string | null>;
}

export interface EngineDeps {
  /** Cookies for auth. Omit to auto-extract from the local browser (getCookies). */
  cookies?: Cookies;
  fetchImpl?: typeof fetch;
  /** Backoff between cold-start retries. Injectable (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable transport (tests). Defaults to a real client over the X API. */
  client?: EngineClient;
  /** Injectable transaction provider (tests). Defaults to the xctid generator. */
  transaction?: TransactionProvider;
}

/** A fresh transaction-id + the homepage bundle can transiently 404; retry this many times. */
const MAX_NOTFOUND_RETRIES = 2;
const RETRY_BACKOFF_MS = 400;

/** A lazy x-client-transaction-id provider that (re)initializes from the X homepage. */
function createTransactionProvider(fetchImpl?: typeof fetch): {
  provider: TransactionProvider;
  refresh: () => Promise<void>;
} {
  let ctPromise: Promise<ClientTransaction> | undefined;
  const init = async (): Promise<ClientTransaction> =>
    ClientTransaction.create(await handleXMigration(fetchImpl));
  const get = (): Promise<ClientTransaction> => {
    if (ctPromise === undefined) ctPromise = init();
    return ctPromise;
  };
  return {
    provider: async (method, path) => (await get()).generateTransactionId(method, path),
    refresh: async () => {
      ctPromise = init();
      await ctPromise;
    },
  };
}

/** Follows bottom cursors, de-duping by id, until `limit`, `stopAtId`, or exhaustion. */
async function paginate(
  fetchPage: (cursor?: string) => Promise<TweetPage>,
  limit: number,
  stopAtId?: string,
): Promise<TweetPage> {
  const tweets: Tweet[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  let emptyStreak = 0;
  let reachedWatermark = false;

  while (tweets.length < limit && !reachedWatermark) {
    const page = await fetchPage(cursor);
    let fresh = 0;
    for (const t of page.tweets) {
      if (stopAtId !== undefined && idLte(t.id, stopAtId)) {
        reachedWatermark = true;
        break;
      }
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      tweets.push(t);
      fresh += 1;
    }

    if (reachedWatermark) break;
    if (fresh === 0) {
      emptyStreak += 1;
      if (emptyStreak >= EMPTY_PAGE_TOLERANCE) break;
    } else {
      emptyStreak = 0;
    }

    if (page.nextCursor === undefined || page.nextCursor === cursor) break;
    cursor = page.nextCursor;
  }

  const out: TweetPage = { tweets: tweets.slice(0, limit) };
  // When we stopped at the watermark the timeline isn't exhausted, but there's
  // nothing newer to fetch, so we intentionally omit nextCursor.
  if (cursor !== undefined && !reachedWatermark) out.nextCursor = cursor;
  return out;
}

/** Follows bottom cursors for a user-list timeline, de-duping by id, up to `limit`. */
async function paginateUsers(
  fetchPage: (cursor?: string) => Promise<UserPage>,
  limit: number,
): Promise<UserPage> {
  const users: UserProfile[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  let emptyStreak = 0;

  while (users.length < limit) {
    const page = await fetchPage(cursor);
    let fresh = 0;
    for (const u of page.users) {
      if (seen.has(u.id)) continue;
      seen.add(u.id);
      users.push(u);
      fresh += 1;
    }
    if (fresh === 0) {
      emptyStreak += 1;
      if (emptyStreak >= EMPTY_PAGE_TOLERANCE) break;
    } else {
      emptyStreak = 0;
    }
    if (page.nextCursor === undefined || page.nextCursor === cursor) break;
    cursor = page.nextCursor;
  }

  const out: UserPage = { users: users.slice(0, limit) };
  if (cursor !== undefined) out.nextCursor = cursor;
  return out;
}

export function createEngine(deps: EngineDeps): Engine {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const txn = deps.transaction
    ? { provider: deps.transaction, refresh: async () => {} }
    : createTransactionProvider(deps.fetchImpl);

  // Resolve cookies lazily (auto-extract from the browser) the first time the
  // network actually needs them; a test-injected client needs none.
  let cookiesCache = deps.cookies;
  const resolveCookies = (): Cookies => {
    if (cookiesCache === undefined) cookiesCache = getCookies();
    return cookiesCache;
  };

  const client: EngineClient =
    deps.client ??
    createClient({
      cookies: resolveCookies(),
      transaction: txn.provider,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });

  // Runs a request; on a stale-transaction-id NOT_FOUND (cold start / rotated
  // bundle), refreshes the generator and retries a few times with backoff.
  async function call(op: OpName, request: BuiltRequest, attempt = 0): Promise<unknown> {
    const res = await client.get(op, request);
    if (res.ok) return res.value;
    if (res.error.code === 'NOT_FOUND' && attempt < MAX_NOTFOUND_RETRIES) {
      await txn.refresh();
      await sleep(RETRY_BACKOFF_MS * (attempt + 1));
      return call(op, request, attempt + 1);
    }
    throw new EngineError(res.error.code, res.error.message, res.error.status);
  }

  // The authenticated user's @handle, via the v1.1 settings endpoint. Memoized.
  let mePromise: Promise<string | null> | undefined;
  async function fetchMe(): Promise<string | null> {
    const path = '/1.1/account/settings.json';
    try {
      const txid = await txn.provider('GET', path);
      const res = await fetchImpl(`https://api.x.com${path}`, {
        headers: buildHeaders({ cookies: resolveCookies(), transactionId: txid }),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { screen_name?: string };
      return data.screen_name ?? null;
    } catch {
      return null;
    }
  }
  const me = (): Promise<string | null> => {
    if (mePromise === undefined) mePromise = fetchMe();
    return mePromise;
  };

  async function getUser(handle: string): Promise<UserProfile | null> {
    const value = await call('UserByScreenName', userByScreenNameRequest({ screenName: handle }));
    const result = findDict(value, 'result', true)[0];
    return parseUserResult(result);
  }

  return {
    me,

    async search(query, opts) {
      const product: SearchProduct = opts?.product ?? 'Top';
      const limit = opts?.limit ?? DEFAULT_LIMIT;
      const page = await paginate(async (cursor) => {
        const value = await call('SearchTimeline', searchRequest({ query, product, cursor }));
        return parseTimeline(value);
      }, limit);
      const out: SearchResult = { query, product, tweets: page.tweets };
      if (page.nextCursor !== undefined) out.nextCursor = page.nextCursor;
      return out;
    },

    user: getUser,

    async userTweets(handle, opts) {
      const profile = await getUser(handle);
      if (!profile) throw new EngineError('NOT_FOUND', `user @${handle} not found`);
      const limit = opts?.limit ?? DEFAULT_LIMIT;
      return paginate(
        async (cursor) => {
          const req = userTweetsRequest({ userId: profile.id, replies: opts?.replies, cursor });
          const value = await call(req.op, req);
          return parseTimeline(value);
        },
        limit,
        opts?.stopAtId,
      );
    },

    async bookmarks(opts) {
      const limit = opts?.limit ?? DEFAULT_LIMIT;
      return paginate(
        async (cursor) => {
          const value = await call('Bookmarks', bookmarksRequest({ cursor }));
          return parseTimeline(value);
        },
        limit,
        opts?.stopAtId,
      );
    },

    async thread(id) {
      const value = await call('TweetDetail', tweetDetailRequest({ focalTweetId: id }));
      return parseThread(value, id);
    },

    async userMedia(handle, opts) {
      const profile = await getUser(handle);
      if (!profile) throw new EngineError('NOT_FOUND', `user @${handle} not found`);
      const limit = opts?.limit ?? DEFAULT_LIMIT;
      return paginate(
        async (cursor) => {
          const value = await call('UserMedia', userMediaRequest({ userId: profile.id, cursor }));
          return parseTimeline(value);
        },
        limit,
        opts?.stopAtId,
      );
    },

    async list(listId, opts) {
      const limit = opts?.limit ?? DEFAULT_LIMIT;
      return paginate(
        async (cursor) => {
          const value = await call('ListLatestTweetsTimeline', listRequest({ listId, cursor }));
          return parseTimeline(value);
        },
        limit,
        opts?.stopAtId,
      );
    },

    followers(handle, opts) {
      return usersByHandle('Followers', handle, opts?.limit ?? DEFAULT_LIMIT);
    },

    following(handle, opts) {
      return usersByHandle('Following', handle, opts?.limit ?? DEFAULT_LIMIT);
    },

    retweeters(tweetId, opts) {
      const limit = opts?.limit ?? DEFAULT_LIMIT;
      return paginateUsers(async (cursor) => {
        const value = await call('Retweeters', userListRequest('tweet', { id: tweetId, cursor }));
        return parseUserTimeline(value);
      }, limit);
    },

    likers(tweetId, opts) {
      const limit = opts?.limit ?? DEFAULT_LIMIT;
      return paginateUsers(async (cursor) => {
        const value = await call('Favoriters', userListRequest('tweet', { id: tweetId, cursor }));
        return parseUserTimeline(value);
      }, limit);
    },

    async quoters(tweetId, opts) {
      // No dedicated op — search for tweets quoting this id (recency-windowed).
      const limit = opts?.limit ?? DEFAULT_LIMIT;
      const product: SearchProduct = opts?.product ?? 'Latest';
      const query = `quoted_tweet_id:${tweetId}`;
      const page = await paginate(async (cursor) => {
        const value = await call('SearchTimeline', searchRequest({ query, product, cursor }));
        return parseTimeline(value);
      }, limit);
      const out: SearchResult = { query, product, tweets: page.tweets };
      if (page.nextCursor !== undefined) out.nextCursor = page.nextCursor;
      return out;
    },

    async trends(opts) {
      // The GraphQL trends timeline rotates its opaque token; the v1.1 REST
      // endpoint is stable and woeid-targeted (1 = worldwide).
      const woeid = opts?.woeid ?? 1;
      const path = '/1.1/trends/place.json';
      const txid = await txn.provider('GET', path);
      const res = await fetchImpl(`https://api.x.com${path}?id=${woeid}`, {
        headers: buildHeaders({ cookies: resolveCookies(), transactionId: txid }),
      });
      if (!res.ok) {
        throw new EngineError('FETCH_FAILED', `trends request failed (${res.status})`, res.status);
      }
      const data = (await res.json()) as Array<{
        trends?: Array<{ name?: string; url?: string; tweet_volume?: number | null }>;
      }>;
      const raw = data[0]?.trends ?? [];
      const out: Trend[] = [];
      for (let i = 0; i < raw.length; i++) {
        const tr = raw[i];
        if (!tr?.name) continue;
        const trend: Trend = { name: tr.name, rank: i + 1 };
        if (tr.url) trend.url = tr.url;
        if (tr.tweet_volume) trend.volume = `${tr.tweet_volume.toLocaleString()} posts`;
        out.push(trend);
      }
      return opts?.limit !== undefined ? out.slice(0, opts.limit) : out;
    },

    async article(tweetId) {
      const value = await call('TweetResultByRestId', tweetResultRequest({ tweetId }));
      return parseArticle(value);
    },

    async media(tweetId) {
      const value = await call('TweetResultByRestId', tweetResultRequest({ tweetId }));
      const result = findDict(value, 'result', true)[0];
      return extractTweetMedia(result);
    },
  };

  function usersByHandle(op: OpName, handle: string, limit: number): Promise<UserPage> {
    return (async () => {
      const profile = await getUser(handle);
      if (!profile) throw new EngineError('NOT_FOUND', `user @${handle} not found`);
      return paginateUsers(async (cursor) => {
        const value = await call(op, userListRequest('user', { id: profile.id, cursor }));
        return parseUserTimeline(value);
      }, limit);
    })();
  }
}
