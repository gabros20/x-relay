import { describe, expect, test } from 'bun:test';
import type { Cookies } from '../src/engine/auth.ts';
import { createClient } from '../src/engine/client.ts';
import { type BuiltRequest, searchRequest } from '../src/engine/ops.ts';

const COOKIES: Cookies = { authToken: 'abc', ct0: 'def' };
const REQUEST: BuiltRequest = searchRequest({ query: 'hello' });

/** A fake fetch driven by a queue of responses (or thrown errors). */
function fakeFetch(queue: Array<Response | Error>): {
  fn: typeof fetch;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const next = queue.shift();
    if (next === undefined) throw new Error('fakeFetch: queue exhausted');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fn, calls };
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function sleepSpy(): { fn: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  const fn = (ms: number): Promise<void> => {
    calls.push(ms);
    return Promise.resolve();
  };
  return { fn, calls };
}

function transactionSpy(): { fn: () => Promise<string>; count: () => number } {
  let n = 0;
  return {
    fn: () => {
      n += 1;
      return Promise.resolve(`txid-${n}`);
    },
    count: () => n,
  };
}

describe('createClient.get', () => {
  test('200 json returns ok + parsed value; one txid; no sleep', async () => {
    const fetchImpl = fakeFetch([jsonResponse({ data: { ok: 1 } })]);
    const sleep = sleepSpy();
    const txn = transactionSpy();
    const client = createClient({
      cookies: COOKIES,
      transaction: txn.fn,
      fetchImpl: fetchImpl.fn,
      sleep: sleep.fn,
    });

    const result = await client.get('SearchTimeline', REQUEST);

    expect(result).toEqual({ ok: true, value: { data: { ok: 1 } } });
    expect(txn.count()).toBe(1);
    expect(sleep.calls.length).toBe(0);
  });

  test('builds the url + path and passes a GET with the txid header', async () => {
    const fetchImpl = fakeFetch([jsonResponse({ data: {} })]);
    const txn = transactionSpy();
    const client = createClient({
      cookies: COOKIES,
      transaction: txn.fn,
      fetchImpl: fetchImpl.fn,
      sleep: sleepSpy().fn,
    });

    await client.get('SearchTimeline', REQUEST);

    const call = fetchImpl.calls[0];
    expect(call).toBeDefined();
    if (call === undefined) throw new Error('no call');
    expect(call.url).toContain('/i/api/graphql/');
    expect(call.url).toContain('SearchTimeline?');
    expect(call.url).toContain('variables=');
    expect(call.init?.method).toBe('GET');
    const headers = call.init?.headers as Record<string, string>;
    expect(headers['x-client-transaction-id']).toBe('txid-1');
  });

  test('429 with reset ~1s ahead, then 200 → sleeps a positive ms then returns value', async () => {
    const reset = Math.floor(Date.now() / 1000) + 1;
    const fetchImpl = fakeFetch([
      jsonResponse(
        { errors: [{ code: 88 }] },
        {
          status: 429,
          headers: { 'x-rate-limit-reset': String(reset), 'x-rate-limit-remaining': '0' },
        },
      ),
      jsonResponse({ data: { ok: 2 } }),
    ]);
    const sleep = sleepSpy();
    const client = createClient({
      cookies: COOKIES,
      transaction: transactionSpy().fn,
      fetchImpl: fetchImpl.fn,
      sleep: sleep.fn,
    });

    const result = await client.get('SearchTimeline', REQUEST);

    expect(result).toEqual({ ok: true, value: { data: { ok: 2 } } });
    expect(sleep.calls.length).toBe(1);
    const slept = sleep.calls[0];
    expect(slept).toBeDefined();
    if (slept === undefined) throw new Error('no sleep');
    expect(slept).toBeGreaterThan(0);
  });

  test('404, 404, 200 → fresh txid each retry (3 calls), returns value', async () => {
    const fetchImpl = fakeFetch([
      new Response('not found', { status: 404 }),
      new Response('not found', { status: 404 }),
      jsonResponse({ data: { ok: 3 } }),
    ]);
    const txn = transactionSpy();
    const client = createClient({
      cookies: COOKIES,
      transaction: txn.fn,
      fetchImpl: fetchImpl.fn,
      sleep: sleepSpy().fn,
    });

    const result = await client.get('SearchTimeline', REQUEST);

    expect(result).toEqual({ ok: true, value: { data: { ok: 3 } } });
    expect(txn.count()).toBe(3);
  });

  test('429 forever → exhausts retries → RATE_LIMITED', async () => {
    const reset = Math.floor(Date.now() / 1000) + 1;
    const rl = () =>
      new Response('rate limited', {
        status: 429,
        headers: { 'x-rate-limit-reset': String(reset) },
      });
    const fetchImpl = fakeFetch([rl(), rl(), rl(), rl(), rl()]);
    const client = createClient({
      cookies: COOKIES,
      transaction: transactionSpy().fn,
      fetchImpl: fetchImpl.fn,
      sleep: sleepSpy().fn,
      maxRetries: 3,
    });

    const result = await client.get('SearchTimeline', REQUEST);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('RATE_LIMITED');
    expect(result.error.status).toBe(429);
  });

  test('200 body with errors code 336 → FEATURE_DRIFT naming the op', async () => {
    const fetchImpl = fakeFetch([
      jsonResponse({ errors: [{ code: 336, message: 'The following features cannot be null' }] }),
    ]);
    const client = createClient({
      cookies: COOKIES,
      transaction: transactionSpy().fn,
      fetchImpl: fetchImpl.fn,
      sleep: sleepSpy().fn,
    });

    const result = await client.get('SearchTimeline', REQUEST);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('FEATURE_DRIFT');
    expect(result.error.message).toContain('SearchTimeline');
    expect(result.error.message).toContain('ops.ts');
  });

  test('200 body with a "features cannot be null" message (no code) → FEATURE_DRIFT', async () => {
    const fetchImpl = fakeFetch([
      jsonResponse({ errors: [{ message: 'The following features cannot be null: foo' }] }),
    ]);
    const client = createClient({
      cookies: COOKIES,
      transaction: transactionSpy().fn,
      fetchImpl: fetchImpl.fn,
      sleep: sleepSpy().fn,
    });

    const result = await client.get('SearchTimeline', REQUEST);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('FEATURE_DRIFT');
  });

  test('400 with a 336 body → FEATURE_DRIFT', async () => {
    const fetchImpl = fakeFetch([
      jsonResponse(
        { errors: [{ code: 336, message: 'features cannot be null' }] },
        { status: 400 },
      ),
    ]);
    const client = createClient({
      cookies: COOKIES,
      transaction: transactionSpy().fn,
      fetchImpl: fetchImpl.fn,
      sleep: sleepSpy().fn,
    });

    const result = await client.get('SearchTimeline', REQUEST);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('FEATURE_DRIFT');
  });

  test('400 generic → BAD_REQUEST', async () => {
    const fetchImpl = fakeFetch([
      jsonResponse({ errors: [{ code: 200, message: 'bad params' }] }, { status: 400 }),
    ]);
    const client = createClient({
      cookies: COOKIES,
      transaction: transactionSpy().fn,
      fetchImpl: fetchImpl.fn,
      sleep: sleepSpy().fn,
    });

    const result = await client.get('SearchTimeline', REQUEST);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('BAD_REQUEST');
    expect(result.error.status).toBe(400);
  });

  test('403 → AUTH_FAILED', async () => {
    const fetchImpl = fakeFetch([new Response('forbidden', { status: 403 })]);
    const client = createClient({
      cookies: COOKIES,
      transaction: transactionSpy().fn,
      fetchImpl: fetchImpl.fn,
      sleep: sleepSpy().fn,
    });

    const result = await client.get('SearchTimeline', REQUEST);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('AUTH_FAILED');
    expect(result.error.status).toBe(403);
  });

  test('401 → AUTH_FAILED', async () => {
    const fetchImpl = fakeFetch([new Response('unauthorized', { status: 401 })]);
    const client = createClient({
      cookies: COOKIES,
      transaction: transactionSpy().fn,
      fetchImpl: fetchImpl.fn,
      sleep: sleepSpy().fn,
    });

    const result = await client.get('SearchTimeline', REQUEST);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('AUTH_FAILED');
    expect(result.error.status).toBe(401);
  });

  test('500 → FETCH_FAILED with status', async () => {
    const fetchImpl = fakeFetch([new Response('boom', { status: 500 })]);
    const client = createClient({
      cookies: COOKIES,
      transaction: transactionSpy().fn,
      fetchImpl: fetchImpl.fn,
      sleep: sleepSpy().fn,
    });

    const result = await client.get('SearchTimeline', REQUEST);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('FETCH_FAILED');
    expect(result.error.status).toBe(500);
  });

  test('a thrown fetch (network) → FETCH_FAILED, never throws', async () => {
    const fetchImpl = fakeFetch([new Error('ECONNRESET')]);
    const client = createClient({
      cookies: COOKIES,
      transaction: transactionSpy().fn,
      fetchImpl: fetchImpl.fn,
      sleep: sleepSpy().fn,
    });

    const result = await client.get('SearchTimeline', REQUEST);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('FETCH_FAILED');
    expect(result.error.message).toContain('ECONNRESET');
  });

  test('404 forever → exhausts retries → NOT_FOUND', async () => {
    const nf = () => new Response('not found', { status: 404 });
    const fetchImpl = fakeFetch([nf(), nf(), nf(), nf(), nf()]);
    const client = createClient({
      cookies: COOKIES,
      transaction: transactionSpy().fn,
      fetchImpl: fetchImpl.fn,
      sleep: sleepSpy().fn,
      maxRetries: 3,
    });

    const result = await client.get('SearchTimeline', REQUEST);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('NOT_FOUND');
    expect(result.error.status).toBe(404);
  });
});
