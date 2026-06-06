import { describe, expect, test } from 'bun:test';
import { createHermesTweetEngine } from '../src/engine/hermes-tweet.ts';
import { type Engine, EngineError } from '../src/engine/index.ts';
import type {
  Article,
  Community,
  MediaItem,
  SearchResult,
  ThreadResult,
  Trend,
  TweetPage,
  UserPage,
  UserProfile,
} from '../src/types.ts';

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function fakeFetch(queue: Response[]): {
  fn: typeof fetch;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const next = queue.shift();
    if (next === undefined) throw new Error('fakeFetch: queue exhausted');
    return next;
  }) as typeof fetch;
  return { fn, calls };
}

function fallbackEngine(calls: string[]): Engine {
  return {
    async search(): Promise<SearchResult> {
      throw new Error('not used');
    },
    async user(): Promise<UserProfile | null> {
      throw new Error('not used');
    },
    async userTweets(handle): Promise<TweetPage> {
      calls.push(`userTweets:${handle}`);
      return { tweets: [] };
    },
    async userMedia(): Promise<TweetPage> {
      throw new Error('not used');
    },
    async bookmarks(): Promise<TweetPage> {
      throw new Error('not used');
    },
    async thread(): Promise<ThreadResult> {
      throw new Error('not used');
    },
    async list(): Promise<TweetPage> {
      throw new Error('not used');
    },
    async followers(): Promise<UserPage> {
      throw new Error('not used');
    },
    async following(): Promise<UserPage> {
      throw new Error('not used');
    },
    async retweeters(): Promise<UserPage> {
      throw new Error('not used');
    },
    async likers(): Promise<UserPage> {
      throw new Error('not used');
    },
    async quoters(): Promise<SearchResult> {
      throw new Error('not used');
    },
    async trends(): Promise<Trend[]> {
      throw new Error('not used');
    },
    async article(): Promise<Article | null> {
      throw new Error('not used');
    },
    async media(): Promise<MediaItem[]> {
      throw new Error('not used');
    },
    async community(): Promise<TweetPage> {
      throw new Error('not used');
    },
    async communityInfo(): Promise<Community | null> {
      throw new Error('not used');
    },
    async me(): Promise<string | null> {
      throw new Error('not used');
    },
  };
}

describe('Hermes Tweet backend', () => {
  test('search calls the Hermes Tweet endpoint and normalizes tweets', async () => {
    const fetchImpl = fakeFetch([
      jsonResponse({
        tweets: [
          {
            tweet_id: 123,
            full_text: 'Hermes Agent launch notes',
            createdAt: '2026-06-06T10:00:00Z',
            author: {
              id: 456,
              screen_name: 'hermes',
              name: 'Hermes',
              verified: true,
              followers_count: '1200',
            },
            public_metrics: {
              like_count: '10',
              retweet_count: 2,
              reply_count: 1,
              quote_count: 3,
            },
            media: [{ type: 'animated_gif' }],
          },
        ],
        nextCursor: 'next-1',
      }),
    ]);
    const engine = createHermesTweetEngine({
      apiKey: 'xq_test',
      baseUrl: 'https://api.example.test/',
      fetchImpl: fetchImpl.fn,
    });

    const result = await engine.search('Hermes Agent', { limit: 5, product: 'Latest' });

    expect(result.query).toBe('Hermes Agent');
    expect(result.product).toBe('Latest');
    expect(result.nextCursor).toBe('next-1');
    expect(result.tweets[0]).toEqual({
      id: '123',
      url: 'https://x.com/hermes/status/123',
      text: 'Hermes Agent launch notes',
      createdAt: '2026-06-06T10:00:00Z',
      author: {
        id: '456',
        handle: 'hermes',
        name: 'Hermes',
        verified: true,
        followers: 1200,
      },
      metrics: { likes: 10, retweets: 2, replies: 1, quotes: 3 },
      media: ['gif'],
    });
    expect(fetchImpl.calls).toHaveLength(1);
    const call = fetchImpl.calls[0];
    expect(call).toBeDefined();
    if (call === undefined) throw new Error('missing call');
    const url = new URL(call.url);
    expect(`${url.origin}${url.pathname}`).toBe('https://api.example.test/api/v1/x/tweets/search');
    expect(url.searchParams.get('q')).toBe('Hermes Agent');
    expect(url.searchParams.get('limit')).toBe('5');
    expect(url.searchParams.get('queryType')).toBe('Latest');
    expect(call.init?.headers).toEqual({
      accept: 'application/json',
      'x-api-key': 'xq_test',
    });
  });

  test('uses bearer auth for non-Xquik tokens and skips unsupported queryType values', async () => {
    const fetchImpl = fakeFetch([jsonResponse({ data: [] })]);
    const engine = createHermesTweetEngine({ apiKey: 'token', fetchImpl: fetchImpl.fn });

    await engine.search('images', { product: 'Media' });

    const call = fetchImpl.calls[0];
    expect(call).toBeDefined();
    if (call === undefined) throw new Error('missing call');
    expect(new URL(call.url).searchParams.has('queryType')).toBe(false);
    expect(call.init?.headers).toEqual({
      accept: 'application/json',
      authorization: 'Bearer token',
    });
  });

  test('user normalizes Hermes Tweet profile responses', async () => {
    const fetchImpl = fakeFetch([
      jsonResponse({
        user: {
          id: 456,
          username: 'hermes',
          name: 'Hermes',
          description: 'Agent runtime',
          followers_count: '1200',
          following_count: 20,
          statuses_count: 30,
          profile_image_url_https: 'https://example.test/avatar.jpg',
        },
      }),
    ]);
    const engine = createHermesTweetEngine({ apiKey: 'xq_test', fetchImpl: fetchImpl.fn });

    const profile = await engine.user('@hermes');

    expect(profile).toEqual({
      id: '456',
      handle: 'hermes',
      name: 'Hermes',
      bio: 'Agent runtime',
      verified: false,
      followers: 1200,
      following: 20,
      tweets: 30,
      createdAt: undefined,
      location: undefined,
      avatar: 'https://example.test/avatar.jpg',
      url: 'https://x.com/hermes',
    });
    expect(new URL(fetchImpl.calls[0]?.url ?? '').pathname).toBe('/api/v1/x/users/hermes');
  });

  test('requires an API key before making network requests', async () => {
    const fetchImpl = fakeFetch([]);
    const engine = createHermesTweetEngine({ fetchImpl: fetchImpl.fn });

    await expect(engine.search('Hermes Agent')).rejects.toThrow(EngineError);
    expect(fetchImpl.calls).toHaveLength(0);
  });

  test('delegates commands not implemented by Hermes Tweet to the fallback engine', async () => {
    const calls: string[] = [];
    const engine = createHermesTweetEngine({
      apiKey: 'xq_test',
      fallback: fallbackEngine(calls),
    });

    await engine.userTweets('hermes', { limit: 2 });

    expect(calls).toEqual(['userTweets:hermes']);
  });
});
