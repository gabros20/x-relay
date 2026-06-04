import { describe, expect, test } from 'bun:test';
import {
  extractTweetMedia,
  parseArticle,
  parseCommunity,
  parseTrends,
  parseUserTimeline,
} from '../src/engine/parse-extra.ts';

// ── parseUserTimeline ────────────────────────────────────────────────────────

/** A user entry wrapping a user_results.result node. */
function userEntry(id: string, handle: string) {
  return {
    entryId: `user-${id}`,
    content: {
      itemContent: {
        itemType: 'TimelineUser',
        user_results: {
          result: {
            __typename: 'User',
            rest_id: id,
            is_blue_verified: false,
            legacy: {
              screen_name: handle,
              name: handle,
              followers_count: 10,
              friends_count: 5,
              statuses_count: 1,
            },
          },
        },
      },
    },
  };
}

function bottomCursorEntry(value: string) {
  return {
    entryId: 'cursor-bottom-0',
    content: { cursorType: 'Bottom', value },
  };
}

function whoToFollowEntry() {
  return {
    entryId: 'who-to-follow-0',
    content: { itemContent: { itemType: 'TimelineUser' } },
  };
}

function userTimelineJson() {
  return {
    data: {
      user: {
        result: {
          timeline: {
            timeline: {
              instructions: [
                {
                  type: 'TimelineAddEntries',
                  entries: [
                    userEntry('1', 'alice'),
                    userEntry('2', 'bob'),
                    userEntry('2', 'bob'), // duplicate id → de-duped
                    whoToFollowEntry(),
                    bottomCursorEntry('NEXT_CURSOR'),
                  ],
                },
              ],
            },
          },
        },
      },
    },
  };
}

describe('parseUserTimeline', () => {
  test('parses user entries + bottom cursor, drops who-to-follow, de-dupes', () => {
    const page = parseUserTimeline(userTimelineJson());
    expect(page.users.map((u) => u.handle)).toEqual(['alice', 'bob']);
    expect(page.nextCursor).toBe('NEXT_CURSOR');
  });

  test('returns empty users + no cursor for an empty response', () => {
    const page = parseUserTimeline({ data: {} });
    expect(page.users).toEqual([]);
    expect(page.nextCursor).toBeUndefined();
  });
});

// ── parseTrends ──────────────────────────────────────────────────────────────

function trendEntry(name: string, rank: number, volume: string) {
  return {
    content: {
      itemContent: {
        trend_results: {
          result: {
            name,
            rank,
            trend_url: { url: `https://x.com/search?q=${name}` },
            trend_metadata: { meta_description: volume },
          },
        },
      },
    },
  };
}

function trendsJson() {
  return {
    data: {
      timeline: {
        timeline: {
          instructions: [
            {
              type: 'TimelineAddEntries',
              entries: [
                trendEntry('Bitcoin', 1, '42.1K posts'),
                trendEntry('Ethereum', 2, '10K posts'),
              ],
            },
          ],
        },
      },
    },
  };
}

describe('parseTrends', () => {
  test('parses trend results with name/rank/url/volume', () => {
    const trends = parseTrends(trendsJson());
    expect(trends).toEqual([
      { name: 'Bitcoin', rank: 1, url: 'https://x.com/search?q=Bitcoin', volume: '42.1K posts' },
      { name: 'Ethereum', rank: 2, url: 'https://x.com/search?q=Ethereum', volume: '10K posts' },
    ]);
  });

  test('returns [] when no trends present', () => {
    expect(parseTrends({ data: {} })).toEqual([]);
  });
});

// ── extractTweetMedia ────────────────────────────────────────────────────────

function photoResult() {
  return {
    legacy: {
      extended_entities: {
        media: [
          {
            type: 'photo',
            media_url_https: 'https://pbs.twimg.com/media/photo.jpg',
            original_info: { width: 1200, height: 800 },
          },
        ],
      },
    },
  };
}

function videoResult() {
  return {
    legacy: {
      extended_entities: {
        media: [
          {
            type: 'video',
            media_url_https: 'https://pbs.twimg.com/thumb.jpg',
            video_info: {
              duration_millis: 30000,
              variants: [
                { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/hls.m3u8' },
                {
                  bitrate: 256000,
                  content_type: 'video/mp4',
                  url: 'https://video.twimg.com/low.mp4',
                },
                {
                  bitrate: 2176000,
                  content_type: 'video/mp4',
                  url: 'https://video.twimg.com/high.mp4',
                },
              ],
            },
          },
        ],
      },
    },
  };
}

function gifResult() {
  return {
    legacy: {
      extended_entities: {
        media: [
          {
            type: 'animated_gif',
            media_url_https: 'https://pbs.twimg.com/gifthumb.jpg',
            video_info: {
              variants: [{ content_type: 'video/mp4', url: 'https://video.twimg.com/gif.mp4' }],
            },
          },
        ],
      },
    },
  };
}

/** Hoisted shape: legacy null, extended_entities on the result root. */
function hoistedPhotoResult() {
  return {
    legacy: null,
    extended_entities: {
      media: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/hoisted.jpg' }],
    },
  };
}

describe('extractTweetMedia', () => {
  test('photo → url + dimensions', () => {
    expect(extractTweetMedia(photoResult())).toEqual([
      {
        type: 'photo',
        url: 'https://pbs.twimg.com/media/photo.jpg',
        width: 1200,
        height: 800,
      },
    ]);
  });

  test('video → highest-bitrate mp4 variant, HLS skipped', () => {
    expect(extractTweetMedia(videoResult())).toEqual([
      {
        type: 'video',
        url: 'https://video.twimg.com/high.mp4',
        bitrate: 2176000,
        thumbnail: 'https://pbs.twimg.com/thumb.jpg',
        durationMs: 30000,
      },
    ]);
  });

  test('gif → first variant url', () => {
    expect(extractTweetMedia(gifResult())).toEqual([
      {
        type: 'gif',
        url: 'https://video.twimg.com/gif.mp4',
        thumbnail: 'https://pbs.twimg.com/gifthumb.jpg',
      },
    ]);
  });

  test('hoisted (legacy null) shape works', () => {
    expect(extractTweetMedia(hoistedPhotoResult())).toEqual([
      { type: 'photo', url: 'https://pbs.twimg.com/hoisted.jpg' },
    ]);
  });

  test('returns [] when no media', () => {
    expect(extractTweetMedia({ legacy: {} })).toEqual([]);
    expect(extractTweetMedia('nope')).toEqual([]);
  });
});

// ── parseArticle ─────────────────────────────────────────────────────────────

function articleJson() {
  return {
    data: {
      tweetResult: {
        result: {
          __typename: 'Tweet',
          rest_id: '1700000000000000000',
          core: {
            user_results: {
              result: {
                __typename: 'User',
                rest_id: '99',
                is_blue_verified: false,
                legacy: { screen_name: 'writer', name: 'Writer', followers_count: 1 },
              },
            },
          },
          legacy: { full_text: 'teaser' },
          article: {
            article_results: {
              result: {
                title: 'My Great Article',
                content_state: {
                  blocks: [
                    { key: 'b1', type: 'header-two', text: 'Intro', entityRanges: [] },
                    {
                      key: 'b2',
                      type: 'unstyled',
                      text: 'See the docs here.',
                      entityRanges: [{ key: 0, offset: 8, length: 4 }],
                    },
                    {
                      key: 'b3',
                      type: 'unordered-list-item',
                      text: 'first point',
                      entityRanges: [],
                    },
                    {
                      key: 'b4',
                      type: 'atomic',
                      text: ' ',
                      entityRanges: [{ key: 1, offset: 0, length: 1 }],
                    },
                  ],
                  entityMap: {
                    '0': {
                      type: 'LINK',
                      mutability: 'MUTABLE',
                      data: { url: 'https://docs.example.com' },
                    },
                    '1': {
                      type: 'MARKDOWN',
                      mutability: 'IMMUTABLE',
                      data: { markdown: '```\ncode block\n```' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

describe('parseArticle', () => {
  test('renders title + blocks to markdown with link splice and atomic markdown', () => {
    const article = parseArticle(articleJson());
    expect(article).not.toBeNull();
    if (article === null) return;
    expect(article.id).toBe('1700000000000000000');
    expect(article.title).toBe('My Great Article');
    expect(article.url).toBe('https://x.com/i/status/1700000000000000000');
    expect(article.markdown).toContain('## Intro');
    expect(article.markdown).toContain('[docs](https://docs.example.com)');
    expect(article.markdown).toContain('- first point');
    expect(article.markdown).toContain('```\ncode block\n```');
  });

  test('returns null when no article_results present', () => {
    expect(parseArticle({ data: { tweetResult: { result: { rest_id: '1' } } } })).toBeNull();
  });
});

// ── parseCommunity ───────────────────────────────────────────────────────────

function communityJson() {
  return {
    data: {
      communityResults: {
        result: {
          __typename: 'Community',
          id_str: '1493446837214187523',
          rest_id: '1493446837214187523',
          name: 'Build in Public',
          description: 'Share what you build',
          member_count: 12345,
          moderator_count: 7,
          created_at: 1644900447551,
          role: 'NonMember',
          join_policy: 'Open',
          primary_community_topic: { topic_id: '603', topic_name: 'Entrepreneurship' },
          rules: [
            { name: 'Be kind', description: 'no flames', rest_id: '1' },
            { name: 'Stay on topic', rest_id: '2' },
          ],
          search_tags: ['buildinpublic', 'indiehackers'],
          creator_results: {
            result: {
              __typename: 'User',
              rest_id: 'u9',
              core: { screen_name: 'levelsio', name: 'Pieter' },
              is_blue_verified: true,
              legacy: { followers_count: 500000 },
            },
          },
        },
      },
    },
  };
}

describe('parseCommunity', () => {
  test('normalizes the community metadata, epoch→ISO, rules/tags, and creator', () => {
    const c = parseCommunity(communityJson());
    expect(c).not.toBeNull();
    if (c === null) return;
    expect(c.id).toBe('1493446837214187523');
    expect(c.name).toBe('Build in Public');
    expect(c.description).toBe('Share what you build');
    expect(c.memberCount).toBe(12345);
    expect(c.moderatorCount).toBe(7);
    expect(c.createdAt).toBe('2022-02-15T04:47:27.551Z');
    expect(c.role).toBe('NonMember');
    expect(c.joinPolicy).toBe('Open');
    expect(c.topic).toBe('Entrepreneurship');
    expect(c.rules).toEqual(['Be kind', 'Stay on topic']);
    expect(c.tags).toEqual(['buildinpublic', 'indiehackers']);
    expect(c.url).toBe('https://x.com/i/communities/1493446837214187523');
    expect(c.creator?.handle).toBe('levelsio');
    expect(c.creator?.verified).toBe(true);
  });

  test('returns null when there is no community result', () => {
    expect(parseCommunity({ data: {} })).toBeNull();
  });
});
