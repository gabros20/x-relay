import { describe, expect, test } from 'bun:test';
import { dispatch, parseArgs } from '../src/cli.ts';
import type { Engine } from '../src/engine/index.ts';
import type {
  Article,
  MediaItem,
  SearchResult,
  ThreadResult,
  Trend,
  TweetPage,
  UserPage,
  UserProfile,
} from '../src/types.ts';

function fakeEngine(calls: string[]): Engine {
  return {
    async search(query, opts): Promise<SearchResult> {
      calls.push(`search:${query}:${opts?.product ?? '-'}:${opts?.limit ?? '-'}`);
      return { query, product: opts?.product ?? 'Top', tweets: [] };
    },
    async user(handle): Promise<UserProfile | null> {
      calls.push(`user:${handle}`);
      return null;
    },
    async userTweets(handle, opts): Promise<TweetPage> {
      calls.push(`userTweets:${handle}:${opts?.replies ?? false}`);
      return { tweets: [] };
    },
    async bookmarks(opts): Promise<TweetPage> {
      calls.push(`bookmarks:${opts?.limit ?? '-'}`);
      return { tweets: [] };
    },
    async thread(id): Promise<ThreadResult> {
      calls.push(`thread:${id}`);
      return { root: {} as never, replies: [] };
    },
    async userMedia(handle): Promise<TweetPage> {
      calls.push(`userMedia:${handle}`);
      return { tweets: [] };
    },
    async list(listId): Promise<TweetPage> {
      calls.push(`list:${listId}`);
      return { tweets: [] };
    },
    async followers(handle): Promise<UserPage> {
      calls.push(`followers:${handle}`);
      return { users: [] };
    },
    async following(handle): Promise<UserPage> {
      calls.push(`following:${handle}`);
      return { users: [] };
    },
    async retweeters(id): Promise<UserPage> {
      calls.push(`retweeters:${id}`);
      return { users: [] };
    },
    async likers(id): Promise<UserPage> {
      calls.push(`likers:${id}`);
      return { users: [] };
    },
    async quoters(id): Promise<SearchResult> {
      calls.push(`quoters:${id}`);
      return { query: `quoted_tweet_id:${id}`, product: 'Latest', tweets: [] };
    },
    async trends(opts): Promise<Trend[]> {
      calls.push(`trends:${opts?.woeid ?? '-'}`);
      return [];
    },
    async article(id): Promise<Article | null> {
      calls.push(`article:${id}`);
      return { id, title: 'T', markdown: '# T', url: `https://x.com/i/status/${id}` };
    },
    async media(id): Promise<MediaItem[]> {
      calls.push(`media:${id}`);
      return [];
    },
    async me(): Promise<string | null> {
      calls.push('me');
      return 'me';
    },
  };
}

describe('parseArgs', () => {
  test('separates command, positionals, value flags, repeatables, and bools', () => {
    const p = parseArgs([
      'search',
      'ai agents',
      '--limit',
      '5',
      '--from',
      'karpathy',
      '--filter',
      'media',
      '--filter',
      '-replies',
      '--product',
      'Latest',
    ]);
    expect(p.command).toBe('search');
    expect(p.positionals).toEqual(['ai agents']);
    expect(p.flags.limit).toEqual(['5']);
    expect(p.flags.filter).toEqual(['media', '-replies']);
    expect(p.flags.product).toEqual(['Latest']);
  });

  test('captures boolean flags', () => {
    const p = parseArgs(['user-posts', 'karpathy', '--replies', '--limit', '3']);
    expect(p.bools.has('replies')).toBe(true);
    expect(p.flags.limit).toEqual(['3']);
  });
});

describe('dispatch', () => {
  test('search builds the query with operators and passes product/limit', async () => {
    const calls: string[] = [];
    const env = await dispatch(
      parseArgs([
        'search',
        'ai agents',
        '--from',
        'karpathy',
        '--limit',
        '5',
        '--product',
        'Latest',
      ]),
      fakeEngine(calls),
    );
    expect(env.ok).toBe(true);
    expect(calls[0]).toBe('search:ai agents from:karpathy:Latest:5');
  });

  test('user extracts a handle from a profile URL', async () => {
    const calls: string[] = [];
    await dispatch(parseArgs(['user', 'https://x.com/karpathy']), fakeEngine(calls));
    expect(calls[0]).toBe('user:karpathy');
  });

  test('thread extracts a tweet id from a status URL', async () => {
    const calls: string[] = [];
    await dispatch(parseArgs(['thread', 'https://x.com/x/status/123456789']), fakeEngine(calls));
    expect(calls[0]).toBe('thread:123456789');
  });

  test('user-posts forwards the replies flag', async () => {
    const calls: string[] = [];
    await dispatch(parseArgs(['user-posts', 'karpathy', '--replies']), fakeEngine(calls));
    expect(calls[0]).toBe('userTweets:karpathy:true');
  });

  test('list / trends / article / media / retweeters dispatch with extracted targets', async () => {
    const calls: string[] = [];
    const eng = fakeEngine(calls);
    await dispatch(parseArgs(['list', '1539453138322673664']), eng);
    await dispatch(parseArgs(['user-media', 'https://x.com/karpathy']), eng);
    await dispatch(parseArgs(['retweeters', 'https://x.com/x/status/123']), eng);
    await dispatch(parseArgs(['trends', '--woeid', '23424977']), eng);
    await dispatch(parseArgs(['article', 'https://x.com/x/status/999']), eng);
    await dispatch(parseArgs(['media', '777']), eng);
    expect(calls).toEqual([
      'list:1539453138322673664',
      'userMedia:karpathy',
      'retweeters:123',
      'trends:23424977',
      'article:999',
      'media:777',
    ]);
  });

  test('unknown command yields an error envelope', async () => {
    const env = await dispatch(parseArgs(['frobnicate']), fakeEngine([]));
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe('UNKNOWN_COMMAND');
  });

  test('empty search query is rejected without calling the engine', async () => {
    const calls: string[] = [];
    const env = await dispatch(parseArgs(['search']), fakeEngine(calls));
    expect(env.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
