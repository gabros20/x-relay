// The GraphQL request driver: pure transport + X/Twitter's resilience policy
// (rate-limit backoff, stale-transaction-id retry, feature-drift detection). It
// returns RAW json — the engine layer parses it. See docs/ENGINE-RESEARCH.md §4.
//
// The driver never imports the x-client-transaction-id generator directly: the
// txid arrives through an injected TransactionProvider, so it stays testable and
// the regeneration-on-404 path is exercisable with a counter.

import type { Cookies } from './auth.ts';
import { buildHeaders } from './auth.ts';
import type { BuiltRequest, OpName } from './ops.ts';
import { encodeParams, graphqlUrl } from './ops.ts';

/** Yields the x-client-transaction-id for a request (method + path bound). */
export type TransactionProvider = (method: string, path: string) => Promise<string>;

export type ClientResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string; status?: number } };

interface CreateClientArgs {
  cookies: Cookies;
  transaction: TransactionProvider;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  clientLanguage?: string;
}

// When X gives no reset header, wait a modest fixed window before retrying.
const DEFAULT_BACKOFF_MS = 1000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Does a parsed body carry X's `(336) features cannot be null` feature-drift signal? */
function isFeatureDrift(body: unknown): boolean {
  if (body === null || typeof body !== 'object') return false;
  const errors = (body as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return false;
  return errors.some((err) => {
    if (err === null || typeof err !== 'object') return false;
    const code = (err as { code?: unknown }).code;
    const message = (err as { message?: unknown }).message;
    if (code === 336) return true;
    return typeof message === 'string' && /features cannot be null/i.test(message);
  });
}

function featureDrift(op: OpName): ClientResult {
  return {
    ok: false,
    error: {
      code: 'FEATURE_DRIFT',
      message: `Feature drift on ${op}: X rejected the features blob — refresh src/engine/ops.ts features/query-ids.`,
    },
  };
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** ms to wait before a 429 retry: until the reset header, else a fixed backoff. */
function backoffMs(res: Response): number {
  const resetHeader = res.headers.get('x-rate-limit-reset');
  const reset = resetHeader === null ? null : Number(resetHeader);
  if (reset === null || !Number.isFinite(reset)) return DEFAULT_BACKOFF_MS;
  const until = reset * 1000 - Date.now();
  return until > 0 ? until : DEFAULT_BACKOFF_MS;
}

// A retry directive: sleep `waitMs` (0 = none) then re-issue the request.
type Retry = { retry: true; waitMs: number };
const RETRY_NOW: Retry = { retry: true, waitMs: 0 };

function isRetry(value: ClientResult | Retry): value is Retry {
  return 'retry' in value;
}

/** Map a non-retryable status to its terminal error result. */
function terminalError(op: OpName, status: number, body: unknown): ClientResult {
  if (status === 400) {
    if (isFeatureDrift(body)) return featureDrift(op);
    return { ok: false, error: { code: 'BAD_REQUEST', status: 400, message: 'Bad request.' } };
  }
  if (status === 401 || status === 403) {
    return {
      ok: false,
      error: {
        code: 'AUTH_FAILED',
        status,
        message: 'Auth failed — session cookies expired or invalid.',
      },
    };
  }
  return {
    ok: false,
    error: { code: 'FETCH_FAILED', status, message: `Request failed with status ${status}.` },
  };
}

export function createClient(args: CreateClientArgs): {
  get(op: OpName, request: BuiltRequest): Promise<ClientResult>;
} {
  const {
    cookies,
    transaction,
    fetchImpl = fetch,
    sleep = defaultSleep,
    maxRetries = 3,
    clientLanguage,
  } = args;

  async function fetchOnce(op: OpName, request: BuiltRequest): Promise<Response> {
    const url = `${graphqlUrl(op)}?${encodeParams(request)}`;
    const path = new URL(url).pathname;
    const txid = await transaction('GET', path);
    const headers = buildHeaders({ cookies, transactionId: txid, clientLanguage });
    return fetchImpl(url, { method: 'GET', headers });
  }

  // Classify one response into either a terminal result or a retry directive,
  // tracking the per-status retry budgets through the mutable `retries` counters.
  async function classify(
    op: OpName,
    res: Response,
    retries: { rateLimit: number; notFound: number },
  ): Promise<ClientResult | Retry> {
    const { status } = res;

    if (status === 200) {
      const body = await safeJson(res);
      return isFeatureDrift(body) ? featureDrift(op) : { ok: true, value: body };
    }

    if (status === 429) {
      if (retries.rateLimit >= maxRetries) {
        return {
          ok: false,
          error: { code: 'RATE_LIMITED', status: 429, message: 'Rate limited; retries exhausted.' },
        };
      }
      retries.rateLimit += 1;
      return { retry: true, waitMs: backoffMs(res) };
    }

    if (status === 404) {
      // X 404s a stale transaction-id; regenerate (the next fetch calls
      // transaction again for a fresh txid) and retry.
      if (retries.notFound >= maxRetries) {
        return {
          ok: false,
          error: {
            code: 'NOT_FOUND',
            status: 404,
            message: 'Not found; retries exhausted (stale txid?).',
          },
        };
      }
      retries.notFound += 1;
      return RETRY_NOW;
    }

    // 400 needs the body for feature-drift detection; other terminals don't.
    const body = status === 400 ? await safeJson(res) : null;
    return terminalError(op, status, body);
  }

  async function get(op: OpName, request: BuiltRequest): Promise<ClientResult> {
    const retries = { rateLimit: 0, notFound: 0 };

    for (;;) {
      let res: Response;
      try {
        res = await fetchOnce(op, request);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: { code: 'FETCH_FAILED', message } };
      }

      const outcome = await classify(op, res, retries);
      if (!isRetry(outcome)) return outcome;
      if (outcome.waitMs > 0) await sleep(outcome.waitMs);
    }
  }

  return { get };
}
