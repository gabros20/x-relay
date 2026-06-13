import { describe, expect, test } from 'bun:test';
import type { Cookies } from '../src/engine/auth.ts';
import { type EngineClient, EngineError, createEngine } from '../src/engine/index.ts';
import type { ArchiveTweet } from '../src/types.ts';

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

describe('communities', () => {
  test('community() maps the feed timeline into a TweetPage', async () => {
    const client = fakeClient({ _start: timeline(['11', '12'], 'cc') });
    const engine = createEngine({ cookies, client });
    const res = await engine.community('149', { limit: 2 });
    expect(res.tweets.map((t) => t.id)).toEqual(['11', '12']);
    expect(res.nextCursor).toBe('cc');
  });

  test('communityInfo() normalizes the community result', async () => {
    const communityJson = {
      data: {
        communityResults: {
          result: { id_str: '149', name: 'Build in Public', member_count: 9 },
        },
      },
    };
    const client = fakeClient({ _start: communityJson });
    const engine = createEngine({ cookies, client });
    const info = await engine.communityInfo('149');
    expect(info?.name).toBe('Build in Public');
    expect(info?.memberCount).toBe(9);
    expect(info?.url).toBe('https://x.com/i/communities/149');
  });
});

describe('account pool rotation', () => {
  /** A one-shot client that fails with `code` until exhausted, then serves `value`. */
  function laneClient(
    code: string | null,
    value: unknown,
    log: string[],
    name: string,
  ): EngineClient {
    return {
      get: async () => {
        log.push(name);
        if (code !== null) return { ok: false, error: { code, message: name } };
        return { ok: true, value };
      },
    };
  }

  test('rotates to the next lane on RATE_LIMITED and returns its result', async () => {
    const log: string[] = [];
    const clients = [
      laneClient('RATE_LIMITED', null, log, 'a'),
      laneClient(null, timeline(['9']), log, 'b'),
    ];
    const engine = createEngine({ cookies, clients, sleep: async () => {} });
    const res = await engine.search('x', { limit: 1 });
    expect(res.tweets.map((t) => t.id)).toEqual(['9']);
    expect(log).toEqual(['a', 'b']);
  });

  test('rotates on AUTH_FAILED (an expired account) to a healthy one', async () => {
    const log: string[] = [];
    const clients = [
      laneClient('AUTH_FAILED', null, log, 'a'),
      laneClient(null, timeline(['7']), log, 'b'),
    ];
    const engine = createEngine({ cookies, clients, sleep: async () => {} });
    const res = await engine.search('x', { limit: 1 });
    expect(res.tweets.map((t) => t.id)).toEqual(['7']);
  });

  test('throws when every lane is rate-limited', async () => {
    const log: string[] = [];
    const clients = [
      laneClient('RATE_LIMITED', null, log, 'a'),
      laneClient('RATE_LIMITED', null, log, 'b'),
    ];
    const engine = createEngine({ cookies, clients, sleep: async () => {} });
    await expect(engine.search('x', { limit: 1 })).rejects.toThrow(EngineError);
    expect(log).toEqual(['a', 'b']);
  });

  test('does not rotate on a non-throttle error (fails fast on the first lane)', async () => {
    const log: string[] = [];
    const clients = [
      laneClient('FETCH_FAILED', null, log, 'a'),
      laneClient(null, timeline(['1']), log, 'b'),
    ];
    const engine = createEngine({ cookies, clients, sleep: async () => {} });
    await expect(engine.search('x', { limit: 1 })).rejects.toThrow(EngineError);
    expect(log).toEqual(['a']);
  });
});

// ── archiveBookmarks fixtures ────────────────────────────────────────────────

/**
 * A rich bookmark timeline page with photo media and createdAt set.
 * Entry ids use the 'tweet-' prefix so parseTimeline picks them up.
 */
function richBookmarkPage(ids: string[], cursor?: string): unknown {
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
                  core: { screen_name: 'bob', name: 'Bob' },
                  legacy: {
                    profile_image_url_https: `https://pbs.twimg.com/profile_images/${id}/photo.jpg`,
                  },
                },
              },
            },
            legacy: {
              full_text: `bookmark tweet ${id}`,
              favorite_count: 5,
              created_at: 'Wed Jun 10 16:06:30 +0000 2026',
              extended_entities: {
                media: [
                  {
                    type: 'photo',
                    media_url_https: `https://pbs.twimg.com/media/${id}.jpg`,
                    original_info: { width: 1200, height: 675 },
                  },
                ],
              },
            },
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
      bookmark_timeline_v2: {
        timeline: { instructions: [{ type: 'TimelineAddEntries', entries }] },
      },
    },
  };
}

// ── archiveUserPosts / archiveMyPosts fixtures ───────────────────────────────

/** A synthetic UserByScreenName response returning a user with the given id and handle. */
function userByScreenNameResponse(userId: string, handle: string): unknown {
  return {
    data: {
      user: {
        result: {
          __typename: 'User',
          rest_id: userId,
          core: { screen_name: handle, name: handle },
          legacy: {},
        },
      },
    },
  };
}

/**
 * A rich user-timeline page (works for both UserTweets and UserTweetsAndReplies).
 * Structurally identical to richBookmarkPage but wrapped in a user_result envelope
 * that parseTimeline still finds via findDict('instructions').
 */
function richUserTimelinePage(ids: string[], cursor?: string): unknown {
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
                  legacy: {
                    profile_image_url_https: `https://pbs.twimg.com/profile_images/${id}/photo.jpg`,
                  },
                },
              },
            },
            legacy: {
              full_text: `user tweet ${id}`,
              favorite_count: 3,
              created_at: 'Wed Jun 10 16:06:30 +0000 2026',
              extended_entities: {
                media: [
                  {
                    type: 'photo',
                    media_url_https: `https://pbs.twimg.com/media/${id}.jpg`,
                    original_info: { width: 800, height: 600 },
                  },
                ],
              },
            },
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
      user: {
        result: {
          timeline_v2: {
            timeline: { instructions: [{ type: 'TimelineAddEntries', entries }] },
          },
        },
      },
    },
  };
}

/**
 * A fake client that serves different canned responses based on op name.
 * - opPages: map of op name → (cursor → value)
 */
function fakeClientByOp(opPages: Record<string, Record<string, unknown>>): EngineClient {
  const log: string[] = [];
  const client: EngineClient & { log: string[] } = {
    log,
    get: async (op, request) => {
      log.push(op);
      const pages = opPages[op] ?? {};
      const cursor = (request.variables as { cursor?: string }).cursor ?? '_start';
      const value = pages[cursor];
      if (value === undefined)
        return {
          ok: false,
          error: { code: 'FETCH_FAILED', message: `no canned page for op=${op} cursor=${cursor}` },
        };
      return { ok: true, value };
    },
  };
  return client;
}

describe('archiveUserPosts', () => {
  test('returns rich ArchiveTweet[] for a user timeline', async () => {
    const userId = '42';
    const handle = 'alice';
    const client = fakeClientByOp({
      UserByScreenName: { _start: userByScreenNameResponse(userId, handle) },
      UserTweets: { _start: richUserTimelinePage(['500', '400']) },
    });
    const engine = createEngine({ cookies, client, sleep: async () => {} });
    const results: ArchiveTweet[] = await engine.archiveUserPosts(handle);
    expect(results).toHaveLength(2);
    expect(results[0]?.id).toBe('500');
    expect(results[0]?.createdAtISO).toBe('2026-06-10T16:06:30+00:00');
    expect(results[0]?.media?.[0]?.url).toMatch(/500\.jpg/);
  });

  test('with --replies uses the UserTweetsAndReplies op', async () => {
    const userId = '42';
    const handle = 'alice';
    const loggedOps: string[] = [];
    const baseClient = fakeClientByOp({
      UserByScreenName: { _start: userByScreenNameResponse(userId, handle) },
      UserTweetsAndReplies: { _start: richUserTimelinePage(['600']) },
    });
    // Wrap to capture ops
    const client: EngineClient = {
      get: async (op, req) => {
        loggedOps.push(op);
        return baseClient.get(op, req);
      },
    };
    const engine = createEngine({ cookies, client, sleep: async () => {} });
    const results = await engine.archiveUserPosts(handle, { replies: true });
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe('600');
    expect(loggedOps).toContain('UserTweetsAndReplies');
    expect(loggedOps).not.toContain('UserTweets');
  });

  test('throws NOT_FOUND when user handle does not exist', async () => {
    const client = fakeClientByOp({
      UserByScreenName: {
        _start: { data: { user: { result: { __typename: 'UserUnavailable' } } } },
      },
    });
    const engine = createEngine({ cookies, client, sleep: async () => {} });
    await expect(engine.archiveUserPosts('ghost')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('membership stop halts after tolerance consecutive known ids', async () => {
    const userId = '42';
    const handle = 'alice';
    const client = fakeClientByOp({
      UserByScreenName: { _start: userByScreenNameResponse(userId, handle) },
      UserTweets: {
        _start: richUserTimelinePage(['10', '9', '8'], 'c1'),
        c1: richUserTimelinePage(['7', '6', '5'], 'c2'),
        c2: richUserTimelinePage(['4', '3', '2'], 'c3'),
      },
    });
    const knownIds = new Set(['7', '6', '5', '4', '3', '2', '1']);
    const engine = createEngine({ cookies, client, sleep: async () => {} });
    const results = await engine.archiveUserPosts(handle, { knownIds });
    expect(results.map((t) => t.id)).toEqual(['10', '9', '8']);
  });
});

describe('archiveMyPosts', () => {
  test('resolves handle via me() and delegates to archiveUserPosts', async () => {
    const userId = '99';
    const handle = 'myself';
    // Provide a fake fetchImpl that serves /1.1/account/settings.json.
    // Also provide a no-op transaction provider so the ClientTransaction init
    // (which fetches the X homepage) is bypassed entirely.
    const settingsResponse = JSON.stringify({ screen_name: handle });
    const fakeFetch = async (url: string | URL | Request): Promise<Response> => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('/1.1/account/settings.json')) {
        return new Response(settingsResponse, { status: 200 });
      }
      return new Response('not found', { status: 404 });
    };
    const client = fakeClientByOp({
      UserByScreenName: { _start: userByScreenNameResponse(userId, handle) },
      UserTweets: { _start: richUserTimelinePage(['700', '800']) },
    });
    const engine = createEngine({
      cookies,
      client,
      sleep: async () => {},
      fetchImpl: fakeFetch as typeof fetch,
      transaction: async () => 'fake-txid',
    });
    const results: ArchiveTweet[] = await engine.archiveMyPosts();
    expect(results).toHaveLength(2);
    expect(results.map((t) => t.id)).toEqual(['700', '800']);
  });

  test('throws INVALID_INPUT when me() returns null', async () => {
    // Use a fetchImpl that always fails for the settings endpoint, and a no-op
    // transaction provider to prevent homepage fetching.
    const fakeFetch = async (): Promise<Response> => new Response('error', { status: 500 });
    const client = fakeClientByOp({});
    const engine = createEngine({
      cookies,
      client,
      sleep: async () => {},
      fetchImpl: fakeFetch as typeof fetch,
      transaction: async () => 'fake-txid',
    });
    await expect(engine.archiveMyPosts()).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('archiveBookmarks', () => {
  test('returns rich ArchiveTweet[] with media url and createdAtISO set', async () => {
    const client = fakeClient({ _start: richBookmarkPage(['100', '200']) });
    const engine = createEngine({ cookies, client, sleep: async () => {} });
    const results: ArchiveTweet[] = await engine.archiveBookmarks();
    expect(results).toHaveLength(2);
    expect(results[0]?.id).toBe('100');
    // media url populated from rich parse
    expect(results[0]?.media).toBeDefined();
    expect(results[0]?.media?.[0]?.url).toMatch(/100\.jpg/);
    // createdAtISO derived from createdAt
    expect(results[0]?.createdAtISO).toBe('2026-06-10T16:06:30+00:00');
  });

  test('membership stop halts after tolerance consecutive known ids', async () => {
    // page 1: ids 10,9,8 — page 2: ids 7,6,5 — all of page 2 are known
    const client = fakeClient({
      _start: richBookmarkPage(['10', '9', '8'], 'c1'),
      c1: richBookmarkPage(['7', '6', '5'], 'c2'),
      c2: richBookmarkPage(['4', '3', '2'], 'c3'),
    });
    // knownIds covers 7,6,5 so after 3 consecutive known ids on page 2 we stop
    const knownIds = new Set(['7', '6', '5', '4', '3', '2', '1']);
    const engine = createEngine({ cookies, client, sleep: async () => {} });
    const results = await engine.archiveBookmarks({ knownIds });
    // Only page 1 tweets (10, 9, 8) should be returned — none of them are known
    // tolerance=3 triggers at the end of page 2 (all 3 known)
    expect(results.map((t) => t.id)).toEqual(['10', '9', '8']);
  });

  test('full mode pages through ignoring knownIds', async () => {
    const client = fakeClient({
      _start: richBookmarkPage(['10', '9', '8'], 'c1'),
      c1: richBookmarkPage(['7', '6', '5']),
    });
    // Even though all ids are "known", full mode ignores knownIds
    const knownIds = new Set(['10', '9', '8', '7', '6', '5']);
    const engine = createEngine({ cookies, client, sleep: async () => {} });
    const results = await engine.archiveBookmarks({ knownIds, full: true });
    expect(results.map((t) => t.id)).toEqual(['10', '9', '8', '7', '6', '5']);
  });

  test('respects limit option', async () => {
    const client = fakeClient({
      _start: richBookmarkPage(['10', '9', '8', '7', '6'], 'c1'),
      c1: richBookmarkPage(['5', '4', '3']),
    });
    const engine = createEngine({ cookies, client, sleep: async () => {} });
    const results = await engine.archiveBookmarks({ limit: 3 });
    expect(results).toHaveLength(3);
    expect(results.map((t) => t.id)).toEqual(['10', '9', '8']);
  });
});
