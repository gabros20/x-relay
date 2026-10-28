import { describe, expect, test } from 'bun:test';
import {
  SYNDICATION_URL,
  fetchSyndicationTweet,
  parseRetryAfter,
  syndicationToken,
} from '../src/engine/syndication.ts';

// The syndication endpoint is X's public, cookie-less embed read path. These tests
// pin the token math (it must match Vercel's react-tweet byte-for-byte or the CDN
// rejects the request) and the status classification + retry policy, with a mocked
// fetch — no network.

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

/** A fetch mock that replays `responses` in order and records each requested URL. */
function scripted(responses: Array<Response | Error>, urls: string[] = []): typeof fetch {
  let i = 0;
  return (async (input: string | URL | Request) => {
    urls.push(String(input));
    const next = responses[i++];
    if (next === undefined) throw new Error('unexpected extra fetch');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
}

const noSleep =
  (waits: number[] = []) =>
  async (ms: number) => {
    waits.push(ms);
  };

describe('syndicationToken', () => {
  test('matches the react-tweet formula: base36 of (id / 1e15) * PI, zeros and dot stripped', () => {
    const id = '2058978952320880679';
    const expected = ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
    expect(syndicationToken(id)).toBe(expected);
  });

  test('is pinned for a known id', () => {
    // Pinned so a refactor that "simplifies" the math is caught. The trailing base36
    // digits of a float can differ between JS engines (V8 vs JSC) for some ids; the
    // CDN only requires a non-empty token today, so that drift is harmless. This id
    // formats identically under Node and Bun.
    expect(syndicationToken('2058978952320880679')).toBe('4zoh17b5uj7');
  });

  test('never contains a dot or a zero', () => {
    for (const id of ['20', '1234567890123456789', '2115270577866842602', '100000000000000000']) {
      expect(syndicationToken(id)).not.toMatch(/[.0]/);
    }
  });
});

describe('parseRetryAfter', () => {
  test('parses delta-seconds to ms', () => {
    expect(parseRetryAfter('3', 0)).toBe(3000);
  });

  test('parses an HTTP date relative to now', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:05 GMT', now)).toBe(5000);
  });

  test('returns undefined for absent or garbage values; clamps past dates to 0', () => {
    expect(parseRetryAfter(null, 0)).toBeUndefined();
    expect(parseRetryAfter('soon', 0)).toBeUndefined();
    const now = Date.parse('2026-01-01T00:00:10Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:05 GMT', now)).toBe(0);
  });
});

describe('fetchSyndicationTweet', () => {
  test('requests the tweet-result endpoint with id + token and returns the tweet', async () => {
    const urls: string[] = [];
    const tweet = { __typename: 'Tweet', id_str: '20', mediaDetails: [] };
    const res = await fetchSyndicationTweet('20', {
      fetchImpl: scripted([json(tweet)], urls),
      sleep: noSleep(),
    });
    expect(res).toEqual({ status: 'ok', tweet });
    const url = new URL(urls[0] ?? '');
    expect(`${url.origin}${url.pathname}`).toBe(SYNDICATION_URL);
    expect(url.searchParams.get('id')).toBe('20');
    expect(url.searchParams.get('token')).toBe(syndicationToken('20'));
  });

  test('a TweetTombstone is unavailable, not an error', async () => {
    const res = await fetchSyndicationTweet('20', {
      fetchImpl: scripted([json({ __typename: 'TweetTombstone', tombstone: { text: {} } })]),
      sleep: noSleep(),
    });
    expect(res).toEqual({ status: 'unavailable', reason: 'tombstone' });
  });

  test('a 404 (and an empty 200 body) is unavailable/not_found, with no retry', async () => {
    const notFound = await fetchSyndicationTweet('20', {
      fetchImpl: scripted([new Response('', { status: 404 })]),
      sleep: noSleep(),
    });
    expect(notFound).toEqual({ status: 'unavailable', reason: 'not_found' });

    const empty = await fetchSyndicationTweet('20', {
      fetchImpl: scripted([new Response('', { status: 200 })]),
      sleep: noSleep(),
    });
    expect(empty).toEqual({ status: 'unavailable', reason: 'not_found' });

    // The CDN answers `{}` when it has nothing (e.g. a missing token).
    const blank = await fetchSyndicationTweet('20', {
      fetchImpl: scripted([json({})]),
      sleep: noSleep(),
    });
    expect(blank).toEqual({ status: 'unavailable', reason: 'not_found' });
  });

  test('retries 429 honoring Retry-After, then succeeds', async () => {
    const waits: number[] = [];
    const res = await fetchSyndicationTweet('20', {
      fetchImpl: scripted([
        new Response('', { status: 429, headers: { 'retry-after': '2' } }),
        json({ __typename: 'Tweet', id_str: '20' }),
      ]),
      sleep: noSleep(waits),
    });
    expect(res.status).toBe('ok');
    expect(waits).toEqual([2000]);
  });

  test('retries 5xx and network errors with exponential backoff', async () => {
    const waits: number[] = [];
    const res = await fetchSyndicationTweet('20', {
      fetchImpl: scripted([
        new Response('', { status: 503 }),
        new TypeError('fetch failed'),
        json({ __typename: 'Tweet', id_str: '20' }),
      ]),
      sleep: noSleep(waits),
      baseDelayMs: 100,
      jitter: () => 0,
    });
    expect(res.status).toBe('ok');
    expect(waits).toEqual([100, 200]);
  });

  test('gives up after `retries` attempts with an error result (never throws)', async () => {
    const res = await fetchSyndicationTweet('20', {
      fetchImpl: scripted([
        new Response('', { status: 500 }),
        new Response('', { status: 500 }),
        new Response('', { status: 500 }),
      ]),
      sleep: noSleep(),
      retries: 2,
    });
    expect(res).toEqual({ status: 'error', message: 'HTTP 500', httpStatus: 500 });
  });

  test('does not retry a non-429 4xx', async () => {
    const urls: string[] = [];
    const res = await fetchSyndicationTweet('20', {
      fetchImpl: scripted([new Response('', { status: 403 })], urls),
      sleep: noSleep(),
    });
    expect(res).toEqual({ status: 'error', message: 'HTTP 403', httpStatus: 403 });
    expect(urls).toHaveLength(1);
  });

  test('a Retry-After beyond maxDelayMs fails fast instead of stalling the run', async () => {
    const waits: number[] = [];
    const res = await fetchSyndicationTweet('20', {
      fetchImpl: scripted([new Response('', { status: 429, headers: { 'retry-after': '900' } })]),
      sleep: noSleep(waits),
      maxDelayMs: 60_000,
    });
    expect(res).toEqual({
      status: 'error',
      message: 'HTTP 429',
      httpStatus: 429,
      retryAfterMs: 900_000,
    });
    expect(waits).toEqual([]);
  });

  test('passes an abort signal so a hung request times out', async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl = (async (_: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return json({ __typename: 'Tweet', id_str: '20' });
    }) as typeof fetch;
    await fetchSyndicationTweet('20', { fetchImpl, sleep: noSleep(), timeoutMs: 1234 });
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  test('a non-JSON 200 body is an error result', async () => {
    const res = await fetchSyndicationTweet('20', {
      fetchImpl: scripted([new Response('<html>', { status: 200 })]),
      sleep: noSleep(),
    });
    expect(res.status).toBe('error');
  });
});
