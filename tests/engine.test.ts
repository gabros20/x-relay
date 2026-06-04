import { describe, expect, test } from 'bun:test';
import type { Cookies } from '../src/engine/auth.ts';
import { type EngineClient, EngineError, createEngine } from '../src/engine/index.ts';

const cookies: Cookies = { authToken: 'a', ct0: 'b' };

// A synthetic search/timeline GraphQL response with N tweet entries + a bottom cursor.
function timeline(ids: string[], cursor?: string): unknown {
  const entries: unknown[] = ids.map((id) => ({
    entryId: `tweet-${id}`,
    content: {
      itemContent: {
        tweet_results: {
          result: {
            __typename: 'Tweet',
            rest_id: id,
            core: {
              user_results: {
                result: {
                  __typename: 'User',
                  rest_id: `u${id}`,
                  core: { screen_name: 'alice', name: 'Alice' },
                  legacy: {},
                },
              },
            },
            legacy: { full_text: `tweet ${id}`, favorite_count: 1 },
          },
        },
      },
    },
  }));
  if (cursor !== undefined) {
    entries.push({
      entryId: `cursor-bottom-${cursor}`,
      content: { cursorType: 'Bottom', value: cursor },
    });
  }
  return {
    data: {
      search_by_raw_query: {
        search_timeline: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries }] } },
      },
    },
  };
}

/** A fake client that serves canned values, keyed by the cursor variable. */
function fakeClient(byCursor: Record<string, unknown>, log?: { ops: string[] }): EngineClient {
  return {
    get: async (op, request) => {
      log?.ops.push(op);
      const cursor = (request.variables as { cursor?: string }).cursor ?? '_start';
      const value = byCursor[cursor];
      if (value === undefined)
        return { ok: false, error: { code: 'FETCH_FAILED', message: 'no canned page' } };
      return { ok: true, value };
    },
  };
}

describe('search', () => {
  test('maps a timeline into a SearchResult and carries the cursor', async () => {
    const client = fakeClient({ _start: timeline(['1', '2'], 'c1') });
    const engine = createEngine({ cookies, client });
    const res = await engine.search('agents', { limit: 2 });
    expect(res.query).toBe('agents');
    expect(res.tweets.map((t) => t.id)).toEqual(['1', '2']);
    expect(res.tweets[0]?.text).toBe('tweet 1');
    expect(res.nextCursor).toBe('c1');
  });

  test('follows cursors across pages until the limit, de-duping by id', async () => {
    const client = fakeClient({
      _start: timeline(['1', '2'], 'c1'),
      c1: timeline(['2', '3', '4'], 'c2'), // '2' repeats — must be de-duped
      c2: timeline(['5'], 'c3'),
    });
    const engine = createEngine({ cookies, client });
    const res = await engine.search('agents', { limit: 4 });
    expect(res.tweets.map((t) => t.id)).toEqual(['1', '2', '3', '4']);
  });

  test('stops on a page with no fresh tweets', async () => {
    const client = fakeClient({
      _start: timeline(['1'], 'c1'),
      c1: timeline([], 'c2'),
      c2: timeline([], 'c3'),
      c3: timeline([], 'c4'),
    });
    const engine = createEngine({ cookies, client });
    const res = await engine.search('agents', { limit: 50 });
    expect(res.tweets.map((t) => t.id)).toEqual(['1']);
  });

  test('uses the requested product', async () => {
    const log = { ops: [] as string[] };
    const client = fakeClient({ _start: timeline(['1']) }, log);
    const engine = createEngine({ cookies, client });
    const res = await engine.search('agents', { product: 'Latest', limit: 1 });
    expect(res.product).toBe('Latest');
    expect(log.ops).toContain('SearchTimeline');
  });
});

describe('thread', () => {
  test('splits root vs replies by focal id', async () => {
    const value = {
      data: {
        threaded_conversation_with_injections_v2: {
          instructions: [
            {
              type: 'TimelineAddEntries',
              entries: [
                {
                  entryId: 'tweet-100',
                  content: {
                    itemContent: {
                      tweet_results: {
                        result: {
                          __typename: 'Tweet',
                          rest_id: '100',
                          core: {
                            user_results: {
                              result: {
                                rest_id: 'u1',
                                core: { screen_name: 'a', name: 'A' },
                                legacy: {},
                              },
                            },
                          },
                          legacy: { full_text: 'root' },
                        },
                      },
                    },
                  },
                },
                {
                  entryId: 'tweet-101',
                  content: {
                    itemContent: {
                      tweet_results: {
                        result: {
                          __typename: 'Tweet',
                          rest_id: '101',
                          core: {
                            user_results: {
                              result: {
                                rest_id: 'u2',
                                core: { screen_name: 'b', name: 'B' },
                                legacy: {},
                              },
                            },
                          },
                          legacy: { full_text: 'reply' },
                        },
                      },
                    },
                  },
                },
              ],
            },
          ],
        },
      },
    };
    const client = fakeClient({ _start: value });
    const engine = createEngine({ cookies, client });
    const res = await engine.thread('100');
    expect(res.root.id).toBe('100');
    expect(res.replies.map((t) => t.id)).toEqual(['101']);
  });
});

describe('bookmarks incremental (stopAtId)', () => {
  test('stops at the watermark id and omits the cursor (nothing newer left)', async () => {
    const client = fakeClient({
      _start: timeline(['10', '9', '8'], 'c1'),
      c1: timeline(['7', '6'], 'c2'),
    });
    const engine = createEngine({ cookies, client });
    const res = await engine.bookmarks({ limit: 50, stopAtId: '8' });
    expect(res.tweets.map((t) => t.id)).toEqual(['10', '9']);
    expect(res.nextCursor).toBeUndefined();
  });
});

describe('cold-start resilience', () => {
  test('retries a transient NOT_FOUND (refresh + backoff) then succeeds', async () => {
    let calls = 0;
    const client: EngineClient = {
      get: async () => {
        calls += 1;
        if (calls <= 2)
          return { ok: false, error: { code: 'NOT_FOUND', status: 404, message: 'x' } };
        return { ok: true, value: timeline(['1']) };
      },
    };
    const engine = createEngine({ cookies, client, sleep: async () => {} });
    const res = await engine.search('x', { limit: 1 });
    expect(res.tweets.map((t) => t.id)).toEqual(['1']);
    expect(calls).toBe(3);
  });

  test('gives up after the NOT_FOUND retry budget', async () => {
    const client: EngineClient = {
      get: async () => ({ ok: false, error: { code: 'NOT_FOUND', status: 404, message: 'x' } }),
    };
    const engine = createEngine({ cookies, client, sleep: async () => {} });
    await expect(engine.search('x', { limit: 1 })).rejects.toThrow(EngineError);
  });
});

describe('errors', () => {
  test('throws EngineError carrying the client error code', async () => {
    const client: EngineClient = {
      get: async () => ({ ok: false, error: { code: 'AUTH_FAILED', message: 'bad cookies' } }),
    };
    const engine = createEngine({ cookies, client });
    await expect(engine.search('x', { limit: 1 })).rejects.toThrow(EngineError);
  });
});
