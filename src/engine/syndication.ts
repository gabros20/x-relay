// ─── syndication: X's public, cookie-less tweet read path ─────────────────
// `cdn.syndication.twimg.com/tweet-result` is the endpoint X's embedded-tweet
// widget (and Vercel's react-tweet) reads. It needs NO cookies and no account,
// so it carries no account risk — the right source for bulk, low-stakes
// backfills (e.g. video posters in `archive repair --media`) and a cheap
// single-tweet read. It returns a flatter, legacy-style shape than GraphQL
// (`mediaDetails[]` with `media_url_https` + `video_info`), and a
// `TweetTombstone` (or a 404) for deleted / protected / withheld posts.
//
// Network lives here (engine/) so callers stay testable: `fetchImpl` and `sleep`
// are injectable, and the function NEVER throws — it classifies every outcome
// into a SyndicationResult.

export const SYNDICATION_URL = 'https://cdn.syndication.twimg.com/tweet-result';

/** One `mediaDetails[]` entry (only the fields x-relay reads are typed). */
export interface SyndicationMedia {
  type?: string;
  id_str?: string;
  media_url_https?: string;
  video_info?: {
    duration_millis?: number;
    variants?: { url?: string; content_type?: string; bitrate?: number }[];
  };
  [key: string]: unknown;
}

/** The tweet-result payload (loosely typed — the endpoint is unversioned). */
export interface SyndicationTweet {
  __typename?: string;
  id_str?: string;
  text?: string;
  mediaDetails?: SyndicationMedia[];
  quoted_tweet?: SyndicationTweet;
  [key: string]: unknown;
}

export type SyndicationResult =
  | { status: 'ok'; tweet: SyndicationTweet }
  /** The post is gone / protected / withheld: a definitive answer, not a failure. */
  | { status: 'unavailable'; reason: 'tombstone' | 'not_found' }
  /** Transport failure after retries, or a non-retryable HTTP status. */
  | { status: 'error'; message: string; httpStatus?: number; retryAfterMs?: number };

export interface SyndicationOpts {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Per-request timeout (default 10s). */
  timeoutMs?: number;
  /** Retries after the first attempt on 429 / 5xx / network errors (default 4). */
  retries?: number;
  /** First backoff step; doubles per retry (default 500ms). */
  baseDelayMs?: number;
  /** Longest single wait. A Retry-After beyond it fails fast instead (default 60s). */
  maxDelayMs?: number;
  /** Jitter source in [0, 1); injectable for deterministic tests. */
  jitter?: () => number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 4;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 60_000;

/**
 * The `token` query param the CDN requires — identical to react-tweet's
 * `getToken`: base36 of `(id / 1e15) * PI` with zeros and the dot stripped.
 */
export function syndicationToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

/** Retry-After (delta-seconds or HTTP-date) → ms to wait; undefined when absent/unparseable. */
export function parseRetryAfter(header: string | null, nowMs: number): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - nowMs);
}

/** One attempt's verdict: a terminal result, or a retryable failure (with an optional server wait). */
type Attempt =
  | { done: SyndicationResult }
  | { retry: { message: string; httpStatus?: number; retryAfterMs?: number } };

async function classify(res: Response): Promise<Attempt> {
  if (res.status === 404) return { done: { status: 'unavailable', reason: 'not_found' } };
  if (res.status === 429 || res.status >= 500) {
    const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'), Date.now());
    return {
      retry: {
        message: `HTTP ${res.status}`,
        httpStatus: res.status,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      },
    };
  }
  if (!res.ok) {
    return { done: { status: 'error', message: `HTTP ${res.status}`, httpStatus: res.status } };
  }
  const body = await res.text();
  // react-tweet treats an empty 200 as "no such tweet".
  if (body.trim().length === 0) return { done: { status: 'unavailable', reason: 'not_found' } };
  let tweet: SyndicationTweet;
  try {
    tweet = JSON.parse(body) as SyndicationTweet;
  } catch {
    return { done: { status: 'error', message: 'invalid JSON from syndication endpoint' } };
  }
  // `{}` is the CDN's "nothing here" answer (also what a missing token yields).
  if (tweet === null || typeof tweet !== 'object' || Object.keys(tweet).length === 0) {
    return { done: { status: 'unavailable', reason: 'not_found' } };
  }
  if (tweet.__typename === 'TweetTombstone') {
    return { done: { status: 'unavailable', reason: 'tombstone' } };
  }
  return { done: { status: 'ok', tweet } };
}

/**
 * Fetch one tweet from the public syndication endpoint. Retries 429 / 5xx /
 * network errors / timeouts with exponential backoff (honoring Retry-After), and
 * never throws — every outcome is a SyndicationResult.
 */
export async function fetchSyndicationTweet(
  id: string,
  opts: SyndicationOpts = {},
): Promise<SyndicationResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const jitter = opts.jitter ?? Math.random;
  const url = `${SYNDICATION_URL}?id=${encodeURIComponent(id)}&token=${syndicationToken(id)}`;

  for (let attempt = 0; ; attempt++) {
    let verdict: Attempt;
    try {
      const res = await fetchImpl(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      verdict = await classify(res);
    } catch (e) {
      // Network failure or timeout (AbortSignal.timeout → TimeoutError): retryable.
      verdict = { retry: { message: e instanceof Error ? e.message : String(e) } };
    }
    if ('done' in verdict) return verdict.done;

    const failure = verdict.retry;
    const exhausted = attempt >= retries;
    const tooLong = failure.retryAfterMs !== undefined && failure.retryAfterMs > maxDelayMs;
    if (exhausted || tooLong) return { status: 'error', ...failure };

    const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt * (1 + jitter() * 0.25));
    await sleep(failure.retryAfterMs ?? backoff);
  }
}
