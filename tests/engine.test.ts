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

// ── archiveSearch / archiveList fixtures ─────────────────────────────────────

/**
 * A rich search timeline page for archiveSearch tests.
 * Reuses the search_by_raw_query envelope that parseTimeline finds.
 */
function richSearchPage(ids: string[], cursor?: string): unknown {
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
                  core: { screen_name: 'carol', name: 'Carol' },
                  legacy: {
                    profile_image_url_https: `https://pbs.twimg.com/profile_images/${id}/photo.jpg`,
                  },
                },
              },
            },
            legacy: {
              full_text: `search tweet ${id}`,
              favorite_count: 7,
              created_at: 'Wed Jun 10 16:06:30 +0000 2026',
              extended_entities: {
                media: [
                  {
                    type: 'photo',
                    media_url_https: `https://pbs.twimg.com/media/${id}.jpg`,
                    original_info: { width: 1024, height: 768 },
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
      search_by_raw_query: {
        search_timeline: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries }] } },
      },
    },
  };
}

/**
 * A rich list timeline page for archiveList tests.
 * Uses the list_latest_tweets_timeline envelope that parseTimeline finds.
 */
function richListPage(ids: string[], cursor?: string): unknown {
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
                  core: { screen_name: 'dave', name: 'Dave' },
                  legacy: {
                    profile_image_url_https: `https://pbs.twimg.com/profile_images/${id}/photo.jpg`,
                  },
                },
              },
            },
            legacy: {
              full_text: `list tweet ${id}`,
              favorite_count: 4,
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
      list: {
        tweets_timeline: {
          timeline: { instructions: [{ type: 'TimelineAddEntries', entries }] },
        },
      },
    },
  };
}

describe('archiveSearch', () => {
  test('returns rich ArchiveTweet[] with media and createdAtISO', async () => {
    const client = fakeClient({ _start: richSearchPage(['501', '502']) });
    const engine = createEngine({ cookies, client, sleep: async () => {} });
    const results: ArchiveTweet[] = await engine.archiveSearch('AI agents');
    expect(results).toHaveLength(2);
    expect(results[0]?.id).toBe('501');
    expect(results[0]?.text).toBe('search tweet 501');
    expect(results[0]?.media?.[0]?.url).toMatch(/501\.jpg/);
    expect(results[0]?.createdAtISO).toBe('2026-06-10T16:06:30+00:00');
  });

  test('uses the SearchTimeline op with the query', async () => {
    const log = { ops: [] as string[] };
    const client = fakeClient({ _start: richSearchPage(['1']) }, log);
    const engine = createEngine({ cookies, client, sleep: async () => {} });
    await engine.archiveSearch('AI agents');
    expect(log.ops).toContain('SearchTimeline');
  });

  test('respects limit option', async () => {
    const client = fakeClient({
      _start: richSearchPage(['10', '9', '8', '7', '6'], 'c1'),
      c1: richSearchPage(['5', '4', '3']),
    });
    const engine = createEngine({ cookies, client, sleep: async () => {} });
    const results = await engine.archiveSearch('AI', { limit: 3 });
    expect(results).toHaveLength(3);
    expect(results.map((t) => t.id)).toEqual(['10', '9', '8']);
  });

  test('does NOT do membership-stop even when knownIds provided (search reorders)', async () => {
    // All page-1 ids are "known" — a regular membership-stop would halt immediately.
    // archiveSearch must ignore knownIds and collect everything.
    const client = fakeClient({
      _start: richSearchPage(['7', '8', '9'], 'c1'),
      c1: richSearchPage(['10', '11', '12']),
    });
    const knownIds = new Set(['7', '8', '9']);
    const engine = createEngine({ cookies, client, sleep: async () => {} });
    const results = await engine.archiveSearch('AI', { knownIds });
    // All 6 tweets collected — membership stop was NOT applied
    expect(results.map((t) => t.id)).toEqual(['7', '8', '9', '10', '11', '12']);
  });

  test('accepts product option', async () => {
    const log = { ops: [] as string[] };
    const client = fakeClient({ _start: richSearchPage(['1']) }, log);
    const engine = createEngine({ cookies, client, sleep: async () => {} });
    const results = await engine.archiveSearch('AI', { product: 'Latest' });
    expect(results).toHaveLength(1);
    expect(log.ops).toContain('SearchTimeline');
  });
});

describe('archiveList', () => {
  test('returns rich ArchiveTweet[] with media and createdAtISO', async () => {
    const client = fakeClient({ _start: richListPage(['601', '602']) });
    const engine = createEngine({ cookies, client, sleep: async () => {} });
    const results: ArchiveTweet[] = await engine.archiveList('mylist123');
    expect(results).toHaveLength(2);
    expect(results[0]?.id).toBe('601');
    expect(results[0]?.text).toBe('list tweet 601');
    expect(results[0]?.media?.[0]?.url).toMatch(/601\.jpg/);
    expect(results[0]?.createdAtISO).toBe('2026-06-10T16:06:30+00:00');
  });

  test('uses the ListLatestTweetsTimeline op', async () => {
    const log = { ops: [] as string[] };
    const client = fakeClient({ _start: richListPage(['1']) }, log);
    const engine = createEngine({ cookies, client, sleep: async () => {} });
    await engine.archiveList('mylist123');
    expect(log.ops).toContain('ListLatestTweetsTimeline');
  });

  test('supports incremental membership-stop (list IS id-ordered)', async () => {
    const client = fakeClient({
      _start: richListPage(['10', '9', '8'], 'c1'),
      c1: richListPage(['7', '6', '5'], 'c2'),
      c2: richListPage(['4', '3', '2'], 'c3'),
    });
    const knownIds = new Set(['7', '6', '5', '4', '3', '2', '1']);
    const engine = createEngine({ cookies, client, sleep: async () => {} });
    const results = await engine.archiveList('mylist123', { knownIds });
    // page 1 (10, 9, 8) all fresh — collected; page 2 (7, 6, 5) all known → tolerance=3 triggers
    expect(results.map((t) => t.id)).toEqual(['10', '9', '8']);
  });

  test('full mode bypasses membership-stop', async () => {
    const client = fakeClient({
      _start: richListPage(['10', '9', '8'], 'c1'),
      c1: richListPage(['7', '6', '5']),
    });
    const knownIds = new Set(['10', '9', '8', '7', '6', '5']);
    const engine = createEngine({ cookies, client, sleep: async () => {} });
    const results = await engine.archiveList('mylist123', { knownIds, full: true });
    expect(results.map((t) => t.id)).toEqual(['10', '9', '8', '7', '6', '5']);
  });

  test('respects limit option', async () => {
    const client = fakeClient({
      _start: richListPage(['10', '9', '8', '7', '6'], 'c1'),
      c1: richListPage(['5', '4', '3']),
    });
    const engine = createEngine({ cookies, client, sleep: async () => {} });
    const results = await engine.archiveList('mylist123', { limit: 3 });
    expect(results).toHaveLength(3);
    expect(results.map((t) => t.id)).toEqual(['10', '9', '8']);
  });
});

// ── likes / archiveLikes fixtures ─────────────────────────────────────────────

/**
 * A rich user-likes timeline page (structurally identical to richUserTimelinePage
 * since Likes and UserTweets share the same user result envelope).
 */
function richLikesPage(ids: string[], cursor?: string): unknown {
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
              full_text: `liked tweet ${id}`,
              favorite_count: 10,
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

describe('likes (research)', () => {
  test('returns a slim TweetPage for a user', async () => {
    const userId = '42';
    const handle = 'alice';
    const client = fakeClientByOp({
      UserByScreenName: { _start: userByScreenNameResponse(userId, handle) },
      Likes: { _start: richLikesPage(['300', '200'], 'c1') },
    });
    const engine = createEngine({ cookies, client, sleep: async () => {} });
    const page = await engine.likes(handle, { limit: 2 });
    expect(page.tweets.map((t) => t.id)).toEqual(['300', '200']);
    expect(page.nextCursor).toBe('c1');
  });

  test('uses the Likes op', async () => {
    const userId = '42';
    const handle = 'alice';
    const loggedOps: string[] = [];
    const baseClient = fakeClientByOp({
      UserByScreenName: { _start: userByScreenNameResponse(userId, handle) },
      Likes: { _start: richLikesPage(['1']) },
    });
    const client: EngineClient = {
      get: async (op, req) => {
        loggedOps.push(op);
        return baseClient.get(op, req);
      },
    };
    const engine = createEngine({ cookies, client, sleep: async () => {} });
    await engine.likes(handle);
    expect(loggedOps).toContain('Likes');
    expect(loggedOps).not.toContain('UserTweets');
  });

  test('throws NOT_FOUND when user handle does not exist', async () => {
    const client = fakeClientByOp({
      UserByScreenName: {
        _start: { data: { user: { result: { __typename: 'UserUnavailable' } } } },
      },
    });
    const engine = createEngine({ cookies, client, sleep: async () => {} });
    await expect(engine.likes('ghost')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('archiveLikes', () => {
  test('returns rich ArchiveTweet[] with media and createdAtISO', async () => {
    const userId = '42';
    const handle = 'alice';
    const client = fakeClientByOp({
      UserByScreenName: { _start: userByScreenNameResponse(userId, handle) },
      Likes: { _start: richLikesPage(['700', '600']) },
    });
    const engine = createEngine({ cookies, client, sleep: async () => {} });
    const results = await engine.archiveLikes(handle);
    expect(results).toHaveLength(2);
    expect(results[0]?.id).toBe('700');
    expect(results[0]?.text).toBe('liked tweet 700');
    expect(results[0]?.media?.[0]?.url).toMatch(/700\.jpg/);
    expect(results[0]?.createdAtISO).toBe('2026-06-10T16:06:30+00:00');
  });

  test('uses the Likes op', async () => {
    const userId = '42';
    const handle = 'alice';
    const loggedOps: string[] = [];
    const baseClient = fakeClientByOp({
      UserByScreenName: { _start: userByScreenNameResponse(userId, handle) },
      Likes: { _start: richLikesPage(['1']) },
    });
    const client: EngineClient = {
      get: async (op, req) => {
        loggedOps.push(op);
        return baseClient.get(op, req);
      },
    };
    const engine = createEngine({ cookies, client, sleep: async () => {} });
    await engine.archiveLikes(handle);
    expect(loggedOps).toContain('Likes');
  });

  test('throws NOT_FOUND when user handle does not exist', async () => {
    const client = fakeClientByOp({
      UserByScreenName: {
        _start: { data: { user: { result: { __typename: 'UserUnavailable' } } } },
      },
    });
    const engine = createEngine({ cookies, client, sleep: async () => {} });
    await expect(engine.archiveLikes('ghost')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('membership stop halts after tolerance consecutive known ids', async () => {
    const userId = '42';
    const handle = 'alice';
    const client = fakeClientByOp({
      UserByScreenName: { _start: userByScreenNameResponse(userId, handle) },
      Likes: {
        _start: richLikesPage(['10', '9', '8'], 'c1'),
        c1: richLikesPage(['7', '6', '5'], 'c2'),
        c2: richLikesPage(['4', '3', '2'], 'c3'),
      },
    });
    const knownIds = new Set(['7', '6', '5', '4', '3', '2', '1']);
    const engine = createEngine({ cookies, client, sleep: async () => {} });
    const results = await engine.archiveLikes(handle, { knownIds });
    expect(results.map((t) => t.id)).toEqual(['10', '9', '8']);
  });

  test('full mode bypasses membership-stop', async () => {
    const userId = '42';
    const handle = 'alice';
    const client = fakeClientByOp({
      UserByScreenName: { _start: userByScreenNameResponse(userId, handle) },
      Likes: {
        _start: richLikesPage(['10', '9', '8'], 'c1'),
        c1: richLikesPage(['7', '6', '5']),
      },
    });
    const knownIds = new Set(['10', '9', '8', '7', '6', '5']);
    const engine = createEngine({ cookies, client, sleep: async () => {} });
    const results = await engine.archiveLikes(handle, { knownIds, full: true });
    expect(results.map((t) => t.id)).toEqual(['10', '9', '8', '7', '6', '5']);
  });
});

// ── feed / archiveFeed fixtures ───────────────────────────────────────────────

/**
 * A synthetic home timeline page. Uses the search_by_raw_query envelope shape
 * (parseTimeline finds instructions anywhere in the value via findDict), so the
 * same richSearchPage factory works for feed pages — both point at the same
 * TimelineAddEntries instruction structure.
 */
function richFeedPage(ids: string[], cursor?: string): unknown {
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
                  core: { screen_name: 'eve', name: 'Eve' },
                  legacy: {
                    profile_image_url_https: `https://pbs.twimg.com/profile_images/${id}/photo.jpg`,
                  },
                },
              },
            },
            legacy: {
              full_text: `feed tweet ${id}`,
              favorite_count: 2,
              created_at: 'Wed Jun 10 16:06:30 +0000 2026',
              extended_entities: {
                media: [
                  {
                    type: 'photo',
                    media_url_https: `https://pbs.twimg.com/media/${id}.jpg`,
                    original_info: { width: 1024, height: 768 },
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
      home: {
        home_timeline_urt: {
          instructions: [{ type: 'TimelineAddEntries', entries }],
        },
      },
    },
  };
}

describe('feed (research)', () => {
  test('returns a slim TweetPage from the for-you timeline (HomeTimeline op)', async () => {
    const loggedOps: string[] = [];
    const baseClient = fakeClient({ _start: richFeedPage(['801', '802'], 'c1') });
    const client: EngineClient = {
      get: async (op, req) => {
        loggedOps.push(op);
        return baseClient.get(op, req);
      },
    };
    const engine = createEngine({ cookies, client, sleep: async () => {} });
    const page = await engine.feed({ limit: 2 });
    expect(page.tweets.map((t) => t.id)).toEqual(['801', '802']);
    expect(page.nextCursor).toBe('c1');
    expect(loggedOps).toContain('HomeTimeline');
    expect(loggedOps).not.toContain('HomeLatestTimeline');
  });

  test('following:true selects the HomeLatestTimeline op', async () => {
    const loggedOps: string[] = [];
    const baseClient = fakeClient({ _start: richFeedPage(['901']) });
    const client: EngineClient = {
      get: async (op, req) => {
        loggedOps.push(op);
        return baseClient.get(op, req);
      },
    };
    const engine = createEngine({ cookies, client, sleep: async () => {} });
    const page = await engine.feed({ following: true, limit: 1 });
    expect(page.tweets.map((t) => t.id)).toEqual(['901']);
    expect(loggedOps).toContain('HomeLatestTimeline');
    expect(loggedOps).not.toContain('HomeTimeline');
  });

  test('follows cursors until limit', async () => {
    const client = fakeClient({
      _start: richFeedPage(['10', '9'], 'c1'),
      c1: richFeedPage(['8', '7'], 'c2'),
    });
    const engine = createEngine({ cookies, client, sleep: async () => {} });
    const page = await engine.feed({ limit: 3 });
    expect(page.tweets.map((t) => t.id)).toEqual(['10', '9', '8']);
  });
});

describe('archiveFeed', () => {
  test('returns rich ArchiveTweet[] with media and createdAtISO', async () => {
    const client = fakeClient({ _start: richFeedPage(['901', '902']) });
    const engine = createEngine({ cookies, client, sleep: async () => {} });
    const results: ArchiveTweet[] = await engine.archiveFeed();
    expect(results).toHaveLength(2);
    expect(results[0]?.id).toBe('901');
    expect(results[0]?.text).toBe('feed tweet 901');
    expect(results[0]?.media?.[0]?.url).toMatch(/901\.jpg/);
    expect(results[0]?.createdAtISO).toBe('2026-06-10T16:06:30+00:00');
  });

  test('following:true uses HomeLatestTimeline op', async () => {
    const loggedOps: string[] = [];
    const baseClient = fakeClient({ _start: richFeedPage(['1']) });
    const client: EngineClient = {
      get: async (op, req) => {
        loggedOps.push(op);
        return baseClient.get(op, req);
      },
    };
    const engine = createEngine({ cookies, client, sleep: async () => {} });
    await engine.archiveFeed({ following: true });
    expect(loggedOps).toContain('HomeLatestTimeline');
    expect(loggedOps).not.toContain('HomeTimeline');
  });

  test('does NOT do membership-stop even when knownIds provided (feed reorders like search)', async () => {
    // All page-1 ids are "known" — a normal membership-stop would halt immediately.
    // archiveFeed must ignore knownIds (always-full approach like archiveSearch).
    const client = fakeClient({
      _start: richFeedPage(['7', '8', '9'], 'c1'),
      c1: richFeedPage(['10', '11', '12']),
    });
    const knownIds = new Set(['7', '8', '9']);
    const engine = createEngine({ cookies, client, sleep: async () => {} });
    const results = await engine.archiveFeed({ knownIds });
    // All 6 tweets collected — membership stop was NOT applied
    expect(results.map((t) => t.id)).toEqual(['7', '8', '9', '10', '11', '12']);
  });

  test('respects limit option', async () => {
    const client = fakeClient({
      _start: richFeedPage(['10', '9', '8', '7', '6'], 'c1'),
      c1: richFeedPage(['5', '4', '3']),
    });
    const engine = createEngine({ cookies, client, sleep: async () => {} });
    const results = await engine.archiveFeed({ limit: 3 });
    expect(results).toHaveLength(3);
    expect(results.map((t) => t.id)).toEqual(['10', '9', '8']);
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
