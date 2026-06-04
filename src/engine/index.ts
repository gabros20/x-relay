// The Engine — the only network-facing surface. Wires the transaction-id
// generator + auth headers + op config + request driver + parser into the
// high-level research operations the commands consume. Network lives here so
// command logic stays pure and testable. See docs/ENGINE-RESEARCH.md.
import type { SearchResult, ThreadResult, Tweet, TweetPage, UserProfile } from '../types.ts';
import type { Cookies } from './auth.ts';
import { type ClientResult, type TransactionProvider, createClient } from './client.ts';
import { getCookies } from './cookies.ts';
import {
  type BuiltRequest,
  type OpName,
  type SearchProduct,
  bookmarksRequest,
  searchRequest,
  tweetDetailRequest,
  userByScreenNameRequest,
  userTweetsRequest,
} from './ops.ts';
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
  bookmarks(opts?: PageOpts): Promise<TweetPage>;
  thread(id: string): Promise<ThreadResult>;
}

export interface EngineDeps {
  /** Cookies for auth. Omit to auto-extract from the local browser (getCookies). */
  cookies?: Cookies;
  fetchImpl?: typeof fetch;
  /** Injectable transport (tests). Defaults to a real client over the X API. */
  client?: EngineClient;
  /** Injectable transaction provider (tests). Defaults to the xctid generator. */
  transaction?: TransactionProvider;
}

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

export function createEngine(deps: EngineDeps): Engine {
  const txn = deps.transaction
    ? { provider: deps.transaction, refresh: async () => {} }
    : createTransactionProvider(deps.fetchImpl);

  // Resolve cookies only when we actually build a network client (auto-extract
  // from the browser if none were passed); a test-injected client needs none.
  const client: EngineClient =
    deps.client ??
    createClient({
      cookies: deps.cookies ?? getCookies(),
      transaction: txn.provider,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });

  // Runs a request; on a stale-transaction-id NOT_FOUND, refreshes the generator
  // once and retries (the bundle may have rotated). Other errors throw.
  async function call(op: OpName, request: BuiltRequest, retried = false): Promise<unknown> {
    const res = await client.get(op, request);
    if (res.ok) return res.value;
    if (res.error.code === 'NOT_FOUND' && !retried) {
      await txn.refresh();
      return call(op, request, true);
    }
    throw new EngineError(res.error.code, res.error.message, res.error.status);
  }

  async function getUser(handle: string): Promise<UserProfile | null> {
    const value = await call('UserByScreenName', userByScreenNameRequest({ screenName: handle }));
    const result = findDict(value, 'result', true)[0];
    return parseUserResult(result);
  }

  return {
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
  };
}
