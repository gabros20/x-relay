// Command runners — thin adapters from parsed options to Engine calls, each
// returning a JSON envelope. Network/transport errors (EngineError) become
// clean error envelopes; the runners hold no business logic of their own.
import { type Engine, EngineError } from '../engine/index.ts';
import type { SearchProduct } from '../engine/ops.ts';
import { err, ok } from '../output.ts';
import type { Envelope, SearchResult, ThreadResult, TweetPage, UserProfile } from '../types.ts';
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

export function runBookmarks(
  engine: Engine,
  opts: { limit?: number },
): Promise<Envelope<TweetPage>> {
  return guard('bookmarks', () =>
    engine.bookmarks({ ...(opts.limit !== undefined ? { limit: opts.limit } : {}) }),
  );
}
