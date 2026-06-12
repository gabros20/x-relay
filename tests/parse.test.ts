import { describe, expect, test } from 'bun:test';
import {
  findDict,
  parseThread,
  parseTimeline,
  parseTweetResult,
  parseUserResult,
} from '../src/engine/parse.ts';

// ── User fixtures ───────────────────────────────────────────────────────────

/** NEW shape: legacy null, identity hoisted into `core` / sub-objects. */
function newUserResult() {
  return {
    __typename: 'User',
    rest_id: '44196397',
    is_blue_verified: true,
    legacy: null,
    core: {
      screen_name: 'elonmusk',
      name: 'Elon Musk',
      created_at: 'Wed Jun 02 20:12:29 +0000 2009',
    },
    avatar: { image_url: 'https://pbs.twimg.com/avatar.jpg' },
    verification: { verified: false },
    profile_bio: { description: 'Tesla, SpaceX' },
    location: { location: 'Mars' },
    relationship_counts: {},
    followers_count: 200_000_000,
    friends_count: 500,
    statuses_count: 40_000,
  };
}

/** OLD shape: everything inside a populated `legacy` block. */
function oldUserResult() {
  return {
    __typename: 'User',
    rest_id: '44196397',
    is_blue_verified: false,
    legacy: {
      screen_name: 'elonmusk',
      name: 'Elon Musk',
      created_at: 'Wed Jun 02 20:12:29 +0000 2009',
      verified: true,
      description: 'Tesla, SpaceX',
      location: 'Mars',
      profile_image_url_https: 'https://pbs.twimg.com/avatar.jpg',
      followers_count: 200_000_000,
      friends_count: 500,
      statuses_count: 40_000,
    },
  };
}

describe('findDict', () => {
  test('collects a deeply-nested key from anywhere in the tree', () => {
    const tree = {
      a: { b: [{ target: 1 }, { c: { target: 2 } }] },
      d: { target: 3 },
    };
    expect(findDict(tree, 'target')).toEqual([1, 2, 3]);
  });

  test('findFirst returns only the first match', () => {
    const tree = { a: { target: 'first' }, b: { target: 'second' } };
    expect(findDict(tree, 'target', true)).toEqual(['first']);
  });

  test('returns empty array when the key is absent', () => {
    expect(findDict({ a: 1 }, 'missing')).toEqual([]);
  });
});

// ── Tweet fixtures ──────────────────────────────────────────────────────────

const SHARED_ENTITIES = {
  hashtags: [{ text: 'rockets' }, { text: 'mars' }],
  user_mentions: [{ screen_name: 'NASA' }],
  urls: [{ expanded_url: 'https://example.com/a' }],
};

const SHARED_MEDIA = {
  media: [{ type: 'photo' }, { type: 'video' }, { type: 'animated_gif' }],
};

/** NEW shape: legacy null, tweet fields hoisted to root, user fields in core. */
function newTweetResult() {
  return {
    __typename: 'Tweet',
    rest_id: '1500000000000000001',
    legacy: null,
    core: { user_results: { result: newUserResult() } },
    views: { count: '12345' },
    full_text: 'Launching to Mars #rockets #mars @NASA https://example.com/a',
    created_at: 'Mon May 04 12:00:00 +0000 2026',
    lang: 'en',
    conversation_id_str: '1500000000000000001',
    favorite_count: 100,
    retweet_count: 20,
    reply_count: 5,
    quote_count: 3,
    bookmark_count: 7,
    entities: SHARED_ENTITIES,
    extended_entities: SHARED_MEDIA,
  };
}

/** OLD shape: every tweet field inside a populated `legacy`; user in core.user_results. */
function oldTweetResult() {
  return {
    __typename: 'Tweet',
    rest_id: '1500000000000000001',
    core: { user_results: { result: oldUserResult() } },
    legacy: {
      full_text: 'Launching to Mars #rockets #mars @NASA https://example.com/a',
      created_at: 'Mon May 04 12:00:00 +0000 2026',
      lang: 'en',
      conversation_id_str: '1500000000000000001',
      favorite_count: 100,
      retweet_count: 20,
      reply_count: 5,
      quote_count: 3,
      bookmark_count: 7,
      ext_views: { count: '12345' },
      entities: SHARED_ENTITIES,
      extended_entities: SHARED_MEDIA,
    },
  };
}

describe('parseTweetResult', () => {
  test('new-shape and old-shape fixtures normalize to the same Tweet', () => {
    const fromNew = parseTweetResult(newTweetResult());
    const fromOld = parseTweetResult(oldTweetResult());
    expect(fromNew).not.toBeNull();
    expect(fromNew).toEqual(fromOld);
  });

  test('maps ids, text, metrics, entities, media and url (new shape)', () => {
    const tweet = parseTweetResult(newTweetResult());
    expect(tweet?.id).toBe('1500000000000000001');
    expect(tweet?.text).toBe('Launching to Mars #rockets #mars @NASA https://example.com/a');
    expect(tweet?.url).toBe('https://x.com/elonmusk/status/1500000000000000001');
    expect(tweet?.lang).toBe('en');
    expect(tweet?.createdAt).toBe('Mon May 04 12:00:00 +0000 2026');
    expect(tweet?.conversationId).toBe('1500000000000000001');
    expect(tweet?.author.handle).toBe('elonmusk');
    expect(tweet?.metrics).toEqual({
      likes: 100,
      retweets: 20,
      replies: 5,
      quotes: 3,
      bookmarks: 7,
      views: 12345,
    });
    expect(tweet?.hashtags).toEqual(['rockets', 'mars']);
    expect(tweet?.mentions).toEqual(['NASA']);
    expect(tweet?.urls).toEqual(['https://example.com/a']);
    expect(tweet?.media).toEqual(['photo', 'video', 'gif']);
  });

  test('parses views from views.count as a number', () => {
    const tweet = parseTweetResult(newTweetResult());
    expect(tweet?.metrics.views).toBe(12345);
  });

  test('long-form note_tweet text overrides full_text', () => {
    const fixture = {
      ...newTweetResult(),
      note_tweet: {
        note_tweet_results: { result: { text: 'The full long-form essay body.' } },
      },
    };
    expect(parseTweetResult(fixture)?.text).toBe('The full long-form essay body.');
  });

  test('unwraps TweetWithVisibilityResults into .tweet', () => {
    const wrapped = {
      __typename: 'TweetWithVisibilityResults',
      tweet: newTweetResult(),
    };
    expect(parseTweetResult(wrapped)?.id).toBe('1500000000000000001');
  });

  test('returns null for a TweetTombstone', () => {
    expect(parseTweetResult({ __typename: 'TweetTombstone' })).toBeNull();
    expect(parseTweetResult(null)).toBeNull();
  });

  test('detects reply / retweet flags', () => {
    const reply = newTweetResult();
    reply.in_reply_to_status_id_str = '1499999999999999999';
    const parsedReply = parseTweetResult(reply);
    expect(parsedReply?.isReply).toBe(true);

    const rt = newTweetResult();
    rt.retweeted_status_result = { result: newTweetResult() };
    expect(parseTweetResult(rt)?.isRetweet).toBe(true);
  });

  test('recurses into quoted_status_result and sets isQuote + .quoted', () => {
    const fixture = newTweetResult();
    const quoted = newTweetResult();
    quoted.rest_id = '1400000000000000000';
    quoted.full_text = 'The quoted original.';
    fixture.quoted_status_id_str = '1400000000000000000';
    fixture.quoted_status_result = { result: quoted };

    const tweet = parseTweetResult(fixture);
    expect(tweet?.isQuote).toBe(true);
    expect(tweet?.quoted?.id).toBe('1400000000000000000');
    expect(tweet?.quoted?.text).toBe('The quoted original.');
  });
});

describe('parseUserResult', () => {
  test('reads core-sourced identity + is_blue_verified when legacy is null', () => {
    const user = parseUserResult(newUserResult());
    expect(user).not.toBeNull();
    expect(user?.handle).toBe('elonmusk');
    expect(user?.name).toBe('Elon Musk');
    expect(user?.verified).toBe(true);
    expect(user?.bio).toBe('Tesla, SpaceX');
    expect(user?.location).toBe('Mars');
    expect(user?.avatar).toBe('https://pbs.twimg.com/avatar.jpg');
    expect(user?.followers).toBe(200_000_000);
    expect(user?.following).toBe(500);
    expect(user?.tweets).toBe(40_000);
    expect(user?.id).toBe('44196397');
    expect(user?.url).toBe('https://x.com/elonmusk');
  });

  test('reads legacy-sourced identity + legacy.verified on the old shape', () => {
    const user = parseUserResult(oldUserResult());
    expect(user?.handle).toBe('elonmusk');
    expect(user?.name).toBe('Elon Musk');
    expect(user?.verified).toBe(true);
    expect(user?.bio).toBe('Tesla, SpaceX');
    expect(user?.avatar).toBe('https://pbs.twimg.com/avatar.jpg');
    expect(user?.followers).toBe(200_000_000);
  });

  test('returns null on a non-user node', () => {
    expect(parseUserResult({ __typename: 'UserUnavailable' })).toBeNull();
    expect(parseUserResult(null)).toBeNull();
  });
});

// ── Timeline fixtures ───────────────────────────────────────────────────────

function tweetWithId(id: string) {
  const t = newTweetResult();
  t.rest_id = id;
  return t;
}

/** A timeline `TimelineAddEntries` entry carrying one tweet. */
function tweetEntry(entryId: string, id: string) {
  return {
    entryId,
    content: {
      entryType: 'TimelineTimelineItem',
      itemContent: { tweet_results: { result: tweetWithId(id) } },
    },
  };
}

function bottomCursorEntry(value: string) {
  return {
    entryId: 'cursor-bottom-0',
    content: { entryType: 'TimelineTimelineCursor', cursorType: 'Bottom', value },
  };
}

/** Wrap entries in the search-path envelope (search_by_raw_query → timeline). */
function searchTimeline(entries: unknown[]) {
  return {
    data: {
      search_by_raw_query: {
        search_timeline: {
          timeline: { instructions: [{ type: 'TimelineAddEntries', entries }] },
        },
      },
    },
  };
}

describe('parseTimeline', () => {
  test('extracts tweets and sets nextCursor from the Bottom cursor entry', () => {
    const json = searchTimeline([
      tweetEntry('tweet-100', '100'),
      tweetEntry('tweet-200', '200'),
      bottomCursorEntry('CURSOR_NEXT'),
    ]);
    const page = parseTimeline(json);
    expect(page.tweets.map((t) => t.id)).toEqual(['100', '200']);
    expect(page.nextCursor).toBe('CURSOR_NEXT');
  });

  test('drops promoted / who-to-follow / cursor entries', () => {
    const json = searchTimeline([
      { entryId: 'promoted-tweet-1', content: {} },
      { entryId: 'who-to-follow-1', content: {} },
      tweetEntry('tweet-100', '100'),
      bottomCursorEntry('CURSOR_NEXT'),
    ]);
    const page = parseTimeline(json);
    expect(page.tweets.map((t) => t.id)).toEqual(['100']);
  });

  test('de-dupes tweets by id', () => {
    const json = searchTimeline([
      tweetEntry('tweet-100', '100'),
      tweetEntry('tweet-100-dup', '100'),
      bottomCursorEntry('CURSOR_NEXT'),
    ]);
    expect(parseTimeline(json).tweets.map((t) => t.id)).toEqual(['100']);
  });

  test('a cursor-only entries array yields no tweets but a cursor', () => {
    const json = searchTimeline([bottomCursorEntry('CURSOR_NEXT')]);
    const page = parseTimeline(json);
    expect(page.tweets).toEqual([]);
    expect(page.nextCursor).toBe('CURSOR_NEXT');
  });

  test('extracts tweets from module entries with items[]', () => {
    const moduleEntry = {
      entryId: 'profile-conversation-1',
      content: {
        entryType: 'TimelineTimelineModule',
        items: [
          { item: { itemContent: { tweet_results: { result: tweetWithId('300') } } } },
          { item: { itemContent: { tweet_results: { result: tweetWithId('301') } } } },
        ],
      },
    };
    const json = searchTimeline([moduleEntry, bottomCursorEntry('CURSOR_NEXT')]);
    expect(parseTimeline(json).tweets.map((t) => t.id)).toEqual(['300', '301']);
  });

  test('skips a single bad tweet without killing the page', () => {
    const badEntry = {
      entryId: 'tweet-bad',
      content: {
        entryType: 'TimelineTimelineItem',
        itemContent: { tweet_results: { result: { __typename: 'TweetTombstone' } } },
      },
    };
    const json = searchTimeline([badEntry, tweetEntry('tweet-100', '100')]);
    expect(parseTimeline(json).tweets.map((t) => t.id)).toEqual(['100']);
  });
});

// ── Thread fixtures ─────────────────────────────────────────────────────────

function tweetDetail(entries: unknown[]) {
  return {
    data: {
      threaded_conversation_with_injections_v2: {
        instructions: [{ type: 'TimelineAddEntries', entries }],
      },
    },
  };
}

describe('parseThread', () => {
  test('splits root vs replies by focalTweetId and carries nextCursor', () => {
    const json = tweetDetail([
      tweetEntry('tweet-500', '500'),
      tweetEntry('tweet-501', '501'),
      tweetEntry('tweet-502', '502'),
      {
        entryId: 'cursor-showmore-1',
        content: {
          entryType: 'TimelineTimelineItem',
          itemContent: { cursorType: 'Bottom', value: 'MORE_REPLIES' },
        },
      },
    ]);
    const thread = parseThread(json, '500');
    expect(thread.root.id).toBe('500');
    expect(thread.replies.map((t) => t.id)).toEqual(['501', '502']);
    expect(thread.nextCursor).toBe('MORE_REPLIES');
  });
});

// ── Rich mode + depth cap + retweet unwrap fixtures ──────────────────────────

/** A tweet result node that carries a photo and a video media item. */
function tweetResultWithMedia() {
  return {
    __typename: 'Tweet',
    rest_id: '2000000000000000001',
    core: { user_results: { result: newUserResult() } },
    views: { count: '999' },
    full_text: 'A tweet with media',
    created_at: 'Mon May 04 12:00:00 +0000 2026',
    lang: 'en',
    favorite_count: 10,
    retweet_count: 2,
    extended_entities: {
      media: [
        {
          type: 'photo',
          media_url_https: 'https://pbs.twimg.com/media/photo.jpg',
          original_info: { width: 1200, height: 800 },
        },
        {
          type: 'video',
          media_url_https: 'https://pbs.twimg.com/media/thumb.jpg',
          original_info: { width: 1280, height: 720 },
          video_info: {
            duration_millis: 30000,
            variants: [
              {
                content_type: 'video/mp4',
                bitrate: 2176000,
                url: 'https://video.twimg.com/ext_tw_video/best.mp4',
              },
            ],
          },
        },
      ],
    },
  };
}

/** A tweet result node that carries an article. */
function tweetResultWithArticle() {
  return {
    __typename: 'Tweet',
    rest_id: '2000000000000000002',
    core: { user_results: { result: newUserResult() } },
    views: { count: '500' },
    full_text: 'An article tweet',
    created_at: 'Mon May 04 12:00:00 +0000 2026',
    lang: 'en',
    favorite_count: 5,
    article: {
      article_results: {
        result: {
          title: 'My Article Title',
          content_state: {
            blocks: [{ type: 'unstyled', text: 'Hello world', entityRanges: [] }],
            entityMap: {},
          },
        },
      },
    },
  };
}

/** An outer retweet result wrapping an inner tweet. */
function retweetResult() {
  const inner = {
    __typename: 'Tweet',
    rest_id: '3000000000000000001',
    core: {
      user_results: {
        result: {
          __typename: 'User',
          rest_id: '12345',
          core: { screen_name: 'original_author', name: 'Original Author' },
          legacy: null,
          followers_count: 1000,
        },
      },
    },
    full_text: 'This is the original tweet content',
    created_at: 'Mon May 04 12:00:00 +0000 2026',
    lang: 'en',
    favorite_count: 50,
    retweet_count: 10,
  };
  return {
    __typename: 'Tweet',
    rest_id: '3000000000000000002',
    core: {
      user_results: {
        result: {
          __typename: 'User',
          rest_id: '99999',
          core: { screen_name: 'retweeter', name: 'The Retweeter' },
          legacy: null,
          followers_count: 500,
        },
      },
    },
    full_text: 'RT @original_author: This is the original tweet content',
    created_at: 'Tue May 05 10:00:00 +0000 2026',
    lang: 'en',
    favorite_count: 0,
    retweet_count: 0,
    retweeted_status_result: { result: inner },
  };
}

/** Build a deeply-nested quoted tweet chain (3 levels deep). */
function deeplyQuotedTweetResult() {
  const level3 = { ...newTweetResult() };
  level3.rest_id = '1000000000000000003';
  level3.full_text = 'Level 3 quoted';

  const level2 = { ...newTweetResult() };
  level2.rest_id = '1000000000000000002';
  level2.full_text = 'Level 2 quoted';
  (level2 as Record<string, unknown>).quoted_status_result = { result: level3 };

  const level1 = { ...newTweetResult() };
  level1.rest_id = '1000000000000000001';
  level1.full_text = 'Level 1 quoted';
  (level1 as Record<string, unknown>).quoted_status_result = { result: level2 };

  const outer = { ...newTweetResult() };
  outer.rest_id = '1000000000000000000';
  outer.full_text = 'Outer tweet quoting level 1';
  (outer as Record<string, unknown>).quoted_status_result = { result: level1 };

  return outer;
}

describe('parseTweetResult — rich mode', () => {
  test('rich mode attaches mediaItems when present', () => {
    const tweet = parseTweetResult(tweetResultWithMedia(), { rich: true });
    expect(tweet).not.toBeNull();
    expect(tweet?.mediaItems).toBeDefined();
    expect(tweet?.mediaItems?.length).toBe(2);
    expect(tweet?.mediaItems?.[0]).toMatchObject({
      type: 'photo',
      url: 'https://pbs.twimg.com/media/photo.jpg',
    });
    expect(tweet?.mediaItems?.[1]).toMatchObject({
      type: 'video',
      url: 'https://video.twimg.com/ext_tw_video/best.mp4',
    });
  });

  test('rich mode attaches article when present', () => {
    const tweet = parseTweetResult(tweetResultWithArticle(), { rich: true });
    expect(tweet).not.toBeNull();
    expect(tweet?.article).toBeDefined();
    expect(tweet?.article?.title).toBe('My Article Title');
    expect(tweet?.article?.markdown).toBe('Hello world');
  });

  test('slim mode (default) does NOT attach mediaItems (regression guard)', () => {
    const tweet = parseTweetResult(tweetResultWithMedia());
    expect(tweet).not.toBeNull();
    expect(tweet?.mediaItems).toBeUndefined();
  });

  test('slim mode (default) does NOT attach article (regression guard)', () => {
    const tweet = parseTweetResult(tweetResultWithArticle());
    expect(tweet).not.toBeNull();
    expect(tweet?.article).toBeUndefined();
  });

  test('rich mode with no media/article attaches nothing extra', () => {
    const tweet = parseTweetResult(newTweetResult(), { rich: true });
    expect(tweet).not.toBeNull();
    // newTweetResult has extended_entities with photo/video/gif media kinds only
    // in the slim media array; but no full media objects with urls → mediaItems absent
    // (the slim fixture does NOT have media_url_https, so extractTweetMedia returns [])
    expect(tweet?.article).toBeUndefined();
  });
});

describe('parseTweetResult — retweet unwrap', () => {
  test('content/author come from the inner tweet, isRetweet true, retweetedBy = outer handle', () => {
    const tweet = parseTweetResult(retweetResult());
    expect(tweet).not.toBeNull();
    expect(tweet?.isRetweet).toBe(true);
    expect(tweet?.retweetedBy).toBe('retweeter');
    // Content comes from inner tweet
    expect(tweet?.text).toBe('This is the original tweet content');
    expect(tweet?.author.handle).toBe('original_author');
    expect(tweet?.id).toBe('3000000000000000002');
  });

  test('retweet unwrap works in rich mode too', () => {
    const tweet = parseTweetResult(retweetResult(), { rich: true });
    expect(tweet?.isRetweet).toBe(true);
    expect(tweet?.retweetedBy).toBe('retweeter');
    expect(tweet?.author.handle).toBe('original_author');
  });
});

describe('parseTweetResult — depth cap on quoted recursion', () => {
  test('quoted nested beyond depth 2 stops recursing (no over-deep quoted)', () => {
    const tweet = parseTweetResult(deeplyQuotedTweetResult());
    expect(tweet).not.toBeNull();
    // outer → level1 quoted (depth 1) → level2 quoted (depth 2) → level3 (depth 3, should be capped)
    expect(tweet?.quoted).toBeDefined(); // level1
    expect(tweet?.quoted?.quoted).toBeDefined(); // level2
    expect(tweet?.quoted?.quoted?.quoted).toBeUndefined(); // level3 — CAPPED
  });

  test('depth cap does not affect the first 2 levels of quoting', () => {
    const tweet = parseTweetResult(deeplyQuotedTweetResult());
    expect(tweet?.quoted?.id).toBe('1000000000000000001');
    expect(tweet?.quoted?.quoted?.id).toBe('1000000000000000002');
  });
});

describe('parseTimeline — rich mode threading', () => {
  test('rich option is threaded down to parseTweetResult (mediaItems populated)', () => {
    const json = searchTimeline([
      {
        entryId: 'tweet-media',
        content: {
          entryType: 'TimelineTimelineItem',
          itemContent: { tweet_results: { result: tweetResultWithMedia() } },
        },
      },
    ]);
    const page = parseTimeline(json, { rich: true });
    expect(page.tweets[0]?.mediaItems).toBeDefined();
    expect(page.tweets[0]?.mediaItems?.length).toBe(2);
  });

  test('slim mode (default) does not pass rich to parseTweetResult', () => {
    const json = searchTimeline([
      {
        entryId: 'tweet-media',
        content: {
          entryType: 'TimelineTimelineItem',
          itemContent: { tweet_results: { result: tweetResultWithMedia() } },
        },
      },
    ]);
    const page = parseTimeline(json);
    expect(page.tweets[0]?.mediaItems).toBeUndefined();
  });
});
