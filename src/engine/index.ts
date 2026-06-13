import { toArchiveTweet } from '../archive.ts';
// The Engine — the only network-facing surface. Wires the transaction-id
// generator + auth headers + op config + request driver + parser into the
// high-level research operations the commands consume. Network lives here so
// command logic stays pure and testable. See docs/ENGINE-RESEARCH.md.
import type {
  ArchiveTweet,
  Article,
  Community,
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
  communityRequest,
  communityTweetsRequest,
  listRequest,
  searchRequest,
  tweetDetailRequest,
  tweetResultRequest,
  userByScreenNameRequest,
  userListRequest,
  userMediaRequest,
  userTweetsRequest,
} from './ops.ts';
import {
  extractTweetMedia,
  parseArticle,
  parseCommunity,
  parseUserTimeline,
} from './parse-extra.ts';
import { findDict, parseThread, parseTimeline, parseUserResult } from './parse.ts';
import {
  type SessionSpec,
  assignProxies,
  makeFetch,
  parseAccounts,
  parseProxyList,
} from './pool.ts';
import { ClientTransaction, handleXMigration } from './xctid/index.ts';

const DEFAULT_LIMIT = 40;
/** `archive --full` pacing: base + jitter (ms) between pages — a single-account
 * rate-limit guard for long (~125-page) sweeps (ARCHIVE-PLAN §9.5#7). */
const ARCHIVE_PAGE_DELAY_MIN_MS = 400;
const ARCHIVE_PAGE_DELAY_JITTER_MS = 400;
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

/** Shared options for any rich-archive timeline sweep (bookmarks/user/list/search/likes/feed). */
export interface ArchiveOpts {
  /** Maximum number of tweets to collect (default: DEFAULT_LIMIT). */
  limit?: number;
  /**
   * Set of already-archived tweet ids. When provided and `full` is not set,
   * pagination stops after `tolerance` consecutive known ids (membership stop).
   */
  knownIds?: Set<string>;
  /**
   * When true, ignore `knownIds` and page through up to `limit` tweets
   * (full rebuild / repair run).
   */
  full?: boolean;
}

export interface ArchiveBookmarksOpts extends ArchiveOpts {}

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
  community(communityId: string, opts?: PageOpts): Promise<TweetPage>;
  communityInfo(communityId: string): Promise<Community | null>;
  /**
   * Fetch bookmarks at full fidelity and return them as ArchiveTweet[].
   * Default (incremental): stops after `tolerance` consecutive known ids when `knownIds` is provided.
   * With `full: true`: ignores `knownIds` and pages up to `limit`.
   */
  archiveBookmarks(opts?: ArchiveBookmarksOpts): Promise<ArchiveTweet[]>;
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
  /** Injectable transport lanes (tests) — drives account-pool rotation. Overrides `client`. */
  clients?: EngineClient[];
  /** Injectable transaction provider (tests). Defaults to the xctid generator. */
  transaction?: TransactionProvider;
}

/** One rotation lane: a transport plus the cookies/fetch the direct-REST helpers reuse. */
interface Lane {
  client: EngineClient;
  cookies: Cookies;
  fetchImpl: typeof fetch;
}

/** Error codes that mean "this account/IP is exhausted" — worth failing over to the next lane. */
const ROTATE_CODES = new Set(['RATE_LIMITED', 'AUTH_FAILED']);

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

/**
 * Optional membership-stop configuration for `paginate`.
 * When provided, paginate counts CONSECUTIVE already-known ids; once the count
 * reaches `tolerance` (default 3) it stops. Only tweets whose id is NOT known
 * are collected.
 */
export interface MembershipStop {
  isKnown: (id: string) => boolean;
  tolerance?: number;
}

/** Follows bottom cursors, de-duping by id, until `limit`, `stopAtId`, `stop`, or exhaustion. */
async function paginate(
  fetchPage: (cursor?: string) => Promise<TweetPage>,
  limit: number,
  stopAtId?: string,
  stop?: MembershipStop,
): Promise<TweetPage> {
  const tweets: Tweet[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  let emptyStreak = 0;
  let reachedWatermark = false;
  const membershipTolerance = stop?.tolerance ?? 3;
  let consecutiveKnown = 0;
  let reachedMembershipStop = false;

  while (tweets.length < limit && !reachedWatermark && !reachedMembershipStop) {
    const page = await fetchPage(cursor);
    let fresh = 0;
    for (const t of page.tweets) {
      if (stopAtId !== undefined && idLte(t.id, stopAtId)) {
        reachedWatermark = true;
        break;
      }
      if (seen.has(t.id)) continue;
      seen.add(t.id);

      if (stop?.isKnown(t.id)) {
        // Known tweet — count toward consecutive streak but don't collect.
        consecutiveKnown += 1;
        if (consecutiveKnown >= membershipTolerance) {
          reachedMembershipStop = true;
          break;
        }
      } else {
        // Fresh (unknown) tweet — reset streak and collect.
        consecutiveKnown = 0;
        tweets.push(t);
        fresh += 1;
      }
    }

    if (reachedWatermark || reachedMembershipStop) break;
    if (fresh === 0 && stop === undefined) {
      emptyStreak += 1;
      if (emptyStreak >= EMPTY_PAGE_TOLERANCE) break;
    } else if (stop === undefined) {
      emptyStreak = 0;
    }

    if (page.nextCursor === undefined || page.nextCursor === cursor) break;
    cursor = page.nextCursor;
  }

  const out: TweetPage = { tweets: tweets.slice(0, limit) };
  // When we stopped at the watermark or membership stop the timeline isn't exhausted,
  // but there's nothing newer to fetch, so we intentionally omit nextCursor.
  if (cursor !== undefined && !reachedWatermark && !reachedMembershipStop) out.nextCursor = cursor;
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

/**
 * Core pagination loop for rich-fidelity archive collection.
 * Shared by all archive targets (bookmarks, user, list, search, likes, feed).
 *
 * @param fetchPage  - Function that fetches one page given an optional cursor.
 * @param opts       - Limit, knownIds (for membership-stop), and full-mode flag.
 * @param sleep      - Injectable sleep (for jittered inter-page pacing on full runs).
 * @returns          - Collected ArchiveTweet[] (up to limit, de-duped, in source order).
 */
async function archiveTimeline(
  fetchPage: (cursor?: string) => Promise<TweetPage>,
  opts: ArchiveOpts,
  sleep: (ms: number) => Promise<void>,
): Promise<ArchiveTweet[]> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const full = opts.full === true;
  const knownIds = opts.knownIds;

  // Build membership stop only for incremental (non-full) runs when knownIds is given.
  const membershipStop: MembershipStop | undefined =
    !full && knownIds !== undefined && knownIds.size > 0
      ? { isKnown: (id) => knownIds.has(id) }
      : undefined;

  let pageCount = 0;
  const page = await paginate(
    async (cursor) => {
      // Polite pacing for full runs: a jittered delay between pages keeps a
      // single-account, ~125-page sweep under X's rate limits (skip first page).
      if (full && pageCount > 0) {
        await sleep(
          ARCHIVE_PAGE_DELAY_MIN_MS + Math.floor(Math.random() * ARCHIVE_PAGE_DELAY_JITTER_MS),
        );
      }
      pageCount += 1;
      return fetchPage(cursor);
    },
    limit,
    undefined,
    membershipStop,
  );

  return page.tweets.map(toArchiveTweet);
}

export function createEngine(deps: EngineDeps): Engine {
  const baseFetch = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const txn = deps.transaction
    ? { provider: deps.transaction, refresh: async () => {} }
    : createTransactionProvider(deps.fetchImpl);

  // Resolve the session pool: XRELAY_ACCOUNTS (multi-account) or a single
  // session from deps.cookies / the browser, each optionally behind a proxy.
  // Cookies auto-extract from the browser only when no explicit ones are given.
  function resolveSpecs(): SessionSpec[] {
    const accountsRaw = (process.env.XRELAY_ACCOUNTS ?? '').trim();
    const proxies = parseProxyList(process.env.XRELAY_PROXIES ?? '');
    let specs = accountsRaw.length > 0 ? parseAccounts(accountsRaw) : [];
    if (specs.length === 0) {
      const spec: SessionSpec = { cookies: deps.cookies ?? getCookies(), label: 'default' };
      const singleProxy = (process.env.XRELAY_PROXY ?? '').trim();
      if (singleProxy.length > 0) spec.proxy = singleProxy;
      specs = [spec];
    }
    return assignProxies(specs, proxies);
  }

  // Build the rotation lanes. Injected clients (tests) become lanes verbatim;
  // otherwise one createClient per session spec, each bound to its proxy fetch.
  function buildLanes(): Lane[] {
    const injected = deps.clients ?? (deps.client ? [deps.client] : undefined);
    const fallbackCookies: Cookies = deps.cookies ?? { authToken: '', ct0: '' };
    if (injected !== undefined) {
      return injected.map((client) => ({ client, cookies: fallbackCookies, fetchImpl: baseFetch }));
    }
    return resolveSpecs().map((spec) => {
      const fetchImpl = makeFetch(spec.proxy, baseFetch);
      return {
        client: createClient({ cookies: spec.cookies, transaction: txn.provider, fetchImpl }),
        cookies: spec.cookies,
        fetchImpl,
      };
    });
  }

  const lanes = buildLanes();
  let current = 0;
  const activeLane = (): Lane => lanes[current] ?? lanes[0] ?? ({} as Lane);

  // One lane's attempt at a request; on a stale-transaction-id NOT_FOUND (cold
  // start / rotated bundle), refresh the generator and retry with backoff.
  async function callLane(
    lane: Lane,
    op: OpName,
    request: BuiltRequest,
    attempt = 0,
  ): Promise<ClientResult> {
    const res = await lane.client.get(op, request);
    if (res.ok) return res;
    if (res.error.code === 'NOT_FOUND' && attempt < MAX_NOTFOUND_RETRIES) {
      await txn.refresh();
      await sleep(RETRY_BACKOFF_MS * (attempt + 1));
      return callLane(lane, op, request, attempt + 1);
    }
    return res;
  }

  // Runs a request through the current lane, failing over to the next lane when
  // the account/IP is exhausted (rate-limited or auth-rejected). Other errors
  // fail fast on the current lane.
  async function call(op: OpName, request: BuiltRequest): Promise<unknown> {
    let lastError: { code: string; message: string; status?: number } = {
      code: 'FETCH_FAILED',
      message: 'no lanes available',
    };
    for (let laneTry = 0; laneTry < lanes.length; laneTry++) {
      const res = await callLane(activeLane(), op, request);
      if (res.ok) return res.value;
      lastError = res.error;
      if (!ROTATE_CODES.has(res.error.code)) break;
      current = (current + 1) % lanes.length;
    }
    throw new EngineError(lastError.code, lastError.message, lastError.status);
  }

  // The authenticated user's @handle, via the v1.1 settings endpoint. Memoized.
  let mePromise: Promise<string | null> | undefined;
  async function fetchMe(): Promise<string | null> {
    const path = '/1.1/account/settings.json';
    try {
      const lane = activeLane();
      const txid = await txn.provider('GET', path);
      const res = await lane.fetchImpl(`https://api.x.com${path}`, {
        headers: buildHeaders({ cookies: lane.cookies, transactionId: txid }),
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
      const lane = activeLane();
      const txid = await txn.provider('GET', path);
      const res = await lane.fetchImpl(`https://api.x.com${path}?id=${woeid}`, {
        headers: buildHeaders({ cookies: lane.cookies, transactionId: txid }),
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

    async community(communityId, opts) {
      const limit = opts?.limit ?? DEFAULT_LIMIT;
      return paginate(
        async (cursor) => {
          const value = await call(
            'CommunityTweetsTimeline',
            communityTweetsRequest({ communityId, cursor }),
          );
          return parseTimeline(value);
        },
        limit,
        opts?.stopAtId,
      );
    },

    async communityInfo(communityId) {
      const value = await call('CommunityByRestId', communityRequest({ communityId }));
      return parseCommunity(value);
    },

    archiveBookmarks(opts) {
      return archiveTimeline(
        async (cursor) => {
          const value = await call('Bookmarks', bookmarksRequest({ cursor, count: 40 }));
          return parseTimeline(value, { rich: true });
        },
        opts ?? {},
        sleep,
      );
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
