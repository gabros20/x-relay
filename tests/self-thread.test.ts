import { describe, expect, test } from 'bun:test';
import {
  extractSelfThread,
  parseSelfThreadPage,
  parseTimeline,
  parseTweetResult,
} from '../src/engine/parse.ts';
import { type EngineClient, createEngine } from '../src/engine/index.ts';
import type { Tweet } from '../src/types.ts';

// ── fixtures ────────────────────────────────────────────────────────────────
// Shapes captured from live TweetDetail responses (Oct 2026): the author's own
// continuation arrives as ONE `conversationthread-*` module whose items carry
// `tweetDisplayType: "SelfThread"`; other people's replies are separate modules of
// `"Tweet"` items. A long self-thread is cut with an in-module `ShowMore` cursor,
// and fetching that cursor returns a `TimelineAddToModule` instruction.

const AUTHOR = { id: '100', handle: 'author' };
const OTHER = { id: '200', handle: 'someone' };

function tweetResult(id: string, user: { id: string; handle: string }, replyTo?: string) {
  return {
    __typename: 'Tweet',
    rest_id: id,
    core: {
      user_results: {
        result: { __typename: 'User', rest_id: user.id, legacy: { screen_name: user.handle, name: user.handle } },
      },
    },
    legacy: {
      full_text: `post ${id}`,
      created_at: 'Tue Oct 27 17:07:45 +0000 2026',
      conversation_id_str: '1000',
      reply_count: 0,
      entities: {},
      ...(replyTo !== undefined ? { in_reply_to_status_id_str: replyTo } : {}),
    },
  };
}

type ItemSpec = { id: string; user: typeof AUTHOR; replyTo?: string; display?: 'SelfThread' | 'Tweet' };

function tweetItem(moduleId: string, spec: ItemSpec) {
  return {
    entryId: `${moduleId}-tweet-${spec.id}`,
    item: {
      itemContent: {
        itemType: 'TimelineTweet',
        tweetDisplayType: spec.display ?? 'Tweet',
        tweet_results: { result: tweetResult(spec.id, spec.user, spec.replyTo) },
      },
    },
  };
}

function showMoreItem(moduleId: string, value: string) {
  return {
    entryId: `${moduleId}-cursor-showmore-1`,
    item: {
      itemContent: {
        itemType: 'TimelineTimelineCursor',
        cursorType: 'ShowMore',
        value,
        displayTreatment: { actionText: 'Show replies' },
      },
    },
  };
}

function module(moduleId: string, items: unknown[]) {
  return {
    entryId: moduleId,
    content: { entryType: 'TimelineTimelineModule', displayType: 'VerticalConversation', items },
  };
}

function focalEntry(id: string) {
  return {
    entryId: `tweet-${id}`,
    content: {
      entryType: 'TimelineTimelineItem',
      itemContent: { itemType: 'TimelineTweet', tweetDisplayType: 'Tweet', tweet_results: { result: tweetResult(id, AUTHOR) } },
    },
  };
}

function detail(instructions: unknown[]) {
  return { data: { threaded_conversation_with_injections_v2: { instructions } } };
}

const self = (id: string, replyTo: string): ItemSpec => ({ id, user: AUTHOR, replyTo, display: 'SelfThread' });

/** Root 1000 → self-thread 1001 → 1002 → 1003 (one module), then other people's conversations. */
function firstPage(opts: { showMore?: string } = {}) {
  const selfModule = module('conversationthread-1001', [
    tweetItem('conversationthread-1001', self('1001', '1000')),
    tweetItem('conversationthread-1001', self('1002', '1001')),
    tweetItem('conversationthread-1001', self('1003', '1002')),
    ...(opts.showMore ? [showMoreItem('conversationthread-1001', opts.showMore)] : []),
  ]);
  const replyModule = module('conversationthread-2001', [
    tweetItem('conversationthread-2001', { id: '2001', user: OTHER, replyTo: '1000' }),
    // The author answering someone — part of the conversation, NOT the thread.
    tweetItem('conversationthread-2001', { id: '2002', user: AUTHOR, replyTo: '2001' }),
    showMoreItem('conversationthread-2001', 'OTHER-MODULE-CURSOR'),
  ]);
  return detail([
    { type: 'TimelineClearCache' },
    { type: 'TimelineAddEntries', entries: [focalEntry('1000'), selfModule, replyModule] },
    { type: 'TimelineTerminateTimeline' },
  ]);
}

/** What X returns for the self-thread module's ShowMore cursor. */
function moreModulePage() {
  return detail([
    {
      type: 'TimelineAddToModule',
      moduleEntryId: 'conversationthread-1001',
      moduleItems: [
        tweetItem('conversationthread-1001', self('1004', '1003')),
        tweetItem('conversationthread-1001', self('1005', '1004')),
      ],
    },
  ]);
}

function tweet(id: string, author: typeof AUTHOR, inReplyToId?: string): Tweet {
  return {
    id,
    url: `https://x.com/${author.handle}/status/${id}`,
    text: `post ${id}`,
    author: { id: author.id, handle: author.handle, name: author.handle, verified: false },
    metrics: {},
    ...(inReplyToId !== undefined ? { isReply: true, inReplyToId } : {}),
  };
}

// ── parse ───────────────────────────────────────────────────────────────────

describe('reply ids', () => {
  test('parseTweetResult keeps the id a reply answers (not just isReply)', () => {
    const t = parseTweetResult(tweetResult('1002', AUTHOR, '1001'));
    expect(t?.isReply).toBe(true);
    expect(t?.inReplyToId).toBe('1001');
  });

  test('a top-level post has no inReplyToId', () => {
    expect(parseTweetResult(tweetResult('1000', AUTHOR))?.inReplyToId).toBeUndefined();
  });
});

describe('TimelineAddToModule', () => {
  test('parseTimeline collects tweets added to an existing module (ShowMore pages)', () => {
    expect(parseTimeline(moreModulePage()).tweets.map((t) => t.id)).toEqual(['1004', '1005']);
  });
});

describe('parseSelfThreadPage', () => {
  test('reads the SelfThread-labelled ids and every tweet on the page', () => {
    const page = parseSelfThreadPage(firstPage());
    expect([...page.selfThreadIds]).toEqual(['1001', '1002', '1003']);
    expect(page.tweets.map((t) => t.id)).toEqual(['1000', '1001', '1002', '1003', '2001', '2002']);
    expect(page.moreCursor).toBeUndefined();
  });

  test('carries the ShowMore cursor of the self-thread module only', () => {
    expect(parseSelfThreadPage(firstPage({ showMore: 'SELF-MORE' })).moreCursor).toBe('SELF-MORE');
  });

  test('a ShowMore page continues the module it was requested for', () => {
    const page = parseSelfThreadPage(moreModulePage());
    expect([...page.selfThreadIds]).toEqual(['1004', '1005']);
    expect(page.tweets.map((t) => t.id)).toEqual(['1004', '1005']);
  });

  test('rich mode attaches mediaItems/article fields like the archive path', () => {
    const page = parseSelfThreadPage(firstPage(), { rich: true });
    expect(page.tweets.length).toBe(6);
  });
});

// ── chain extraction ────────────────────────────────────────────────────────

describe('extractSelfThread', () => {
  const root = tweet('1000', AUTHOR);

  test('keeps only the author’s reply chain, oldest first', () => {
    const candidates = [
      tweet('1003', AUTHOR, '1002'),
      tweet('2001', OTHER, '1000'),
      tweet('1001', AUTHOR, '1000'),
      tweet('2002', AUTHOR, '2001'), // author answering someone else
      tweet('1002', AUTHOR, '1001'),
    ];
    expect(extractSelfThread(root, candidates, new Set()).map((t) => t.id)).toEqual(['1001', '1002', '1003']);
  });

  test('a branch off the chain by the author still counts (reply to any thread post)', () => {
    const candidates = [tweet('1001', AUTHOR, '1000'), tweet('1005', AUTHOR, '1001'), tweet('1002', AUTHOR, '1001')];
    expect(extractSelfThread(root, candidates, new Set()).map((t) => t.id)).toEqual(['1001', '1002', '1005']);
  });

  test('ignores another account replying inside the chain', () => {
    const candidates = [tweet('1001', AUTHOR, '1000'), tweet('1002', OTHER, '1001')];
    expect(extractSelfThread(root, candidates, new Set()).map((t) => t.id)).toEqual(['1001']);
  });

  test('falls back to X’s SelfThread label when a reply id is missing', () => {
    const candidates = [tweet('1001', AUTHOR), tweet('1002', AUTHOR)];
    expect(extractSelfThread(root, candidates, new Set(['1001'])).map((t) => t.id)).toEqual(['1001']);
  });

  test('never includes the root itself or duplicates', () => {
    const candidates = [root, tweet('1001', AUTHOR, '1000'), tweet('1001', AUTHOR, '1000')];
    expect(extractSelfThread(root, candidates, new Set(['1000'])).map((t) => t.id)).toEqual(['1001']);
  });

  test('empty when the root has no author id (deleted / unavailable post)', () => {
    const ghost = { ...root, author: { ...root.author, id: '' } };
    expect(extractSelfThread(ghost, [tweet('1001', AUTHOR, '1000')], new Set())).toEqual([]);
  });
});

// ── engine.selfThread ───────────────────────────────────────────────────────

/** Serves canned TweetDetail pages keyed by the request's cursor variable. */
function fakeClient(byCursor: Record<string, unknown>, log: string[] = []): EngineClient {
  return {
    get: async (_op, request) => {
      const vars = request.variables as { cursor?: string; focalTweetId?: string };
      log.push(`${vars.focalTweetId}:${vars.cursor ?? '_start'}`);
      const value = byCursor[vars.cursor ?? '_start'];
      if (value === undefined) return { ok: false, error: { code: 'FETCH_FAILED', message: 'no canned page' } };
      return { ok: true, value };
    },
  };
}

const cookies = { authToken: 'a', ct0: 'c' };

describe('engine.selfThread', () => {
  test('reads the thread on the first page and follows the self-thread ShowMore cursor', async () => {
    const log: string[] = [];
    const client = fakeClient({ _start: firstPage({ showMore: 'SELF-MORE' }), 'SELF-MORE': moreModulePage() }, log);
    const res = await createEngine({ cookies, client }).selfThread('1000');
    expect(res.root.id).toBe('1000');
    expect(res.thread.map((t) => t.id)).toEqual(['1001', '1002', '1003', '1004', '1005']);
    expect(res.pages).toBe(2);
    expect(res.complete).toBe(true);
    expect(log).toEqual(['1000:_start', '1000:SELF-MORE']);
  });

  test('one call for a post without a thread (other people’s ShowMore cursors are not followed)', async () => {
    const log: string[] = [];
    const page = detail([
      { type: 'TimelineAddEntries', entries: [focalEntry('1000'), module('conversationthread-2001', [
        tweetItem('conversationthread-2001', { id: '2001', user: OTHER, replyTo: '1000' }),
        showMoreItem('conversationthread-2001', 'OTHER'),
      ])] },
    ]);
    const res = await createEngine({ cookies, client: fakeClient({ _start: page }, log) }).selfThread('1000');
    expect(res.thread).toEqual([]);
    expect(res.complete).toBe(true);
    expect(log.length).toBe(1);
  });

  test('stops at maxPages and says the thread may continue', async () => {
    const client = fakeClient({ _start: firstPage({ showMore: 'SELF-MORE' }), 'SELF-MORE': moreModulePage() });
    const res = await createEngine({ cookies, client }).selfThread('1000', { maxPages: 1 });
    expect(res.thread.map((t) => t.id)).toEqual(['1001', '1002', '1003']);
    expect(res.complete).toBe(false);
  });
});
