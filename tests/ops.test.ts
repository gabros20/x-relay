import { describe, expect, test } from 'bun:test';
import {
  FEATURES,
  OPS,
  bookmarksRequest,
  communityRequest,
  communityTweetsRequest,
  encodeParams,
  graphqlUrl,
  likesRequest,
  searchRequest,
  tweetDetailRequest,
  userByScreenNameRequest,
  userTweetsRequest,
} from '../src/engine/ops.ts';

describe('OPS + graphqlUrl', () => {
  test('graphqlUrl builds the /graphql/<id>/<OperationName> URL', () => {
    const { queryId } = OPS.SearchTimeline;
    expect(graphqlUrl('SearchTimeline')).toBe(
      `https://x.com/i/api/graphql/${queryId}/SearchTimeline`,
    );
  });

  test('every required op is present with a queryId + operationName', () => {
    const required = [
      'SearchTimeline',
      'UserByScreenName',
      'UserByRestId',
      'UserTweets',
      'UserTweetsAndReplies',
      'Bookmarks',
      'TweetDetail',
      'Followers',
      'Following',
      'ListLatestTweetsTimeline',
    ] as const;
    for (const op of required) {
      expect(OPS[op].queryId.length).toBeGreaterThan(0);
      expect(OPS[op].operationName).toBe(op);
    }
  });
});

describe('FEATURES', () => {
  test('is the ~37-key flags blob with known keys set to booleans', () => {
    expect(Object.keys(FEATURES).length).toBeGreaterThanOrEqual(35);
    expect(typeof FEATURES.responsive_web_graphql_timeline_navigation_enabled).toBe('boolean');
  });
});

describe('searchRequest', () => {
  test('defaults product to Latest with typed_query source and count 20', () => {
    const { variables, fieldToggles } = searchRequest({ query: 'from:jack since:2026-01-01' });
    const v = variables as Record<string, unknown>;
    expect(v.product).toBe('Latest');
    expect(v.querySource).toBe('typed_query');
    expect(v.count).toBe(20);
    expect(v.rawQuery).toBe('from:jack since:2026-01-01');
    expect(fieldToggles).toEqual({ withArticleRichContentState: false });
  });

  test('passes the raw query through untouched (no operator builder)', () => {
    const raw = 'AI -filter:replies min_faves:100 "exact phrase" OR #tag';
    const { variables } = searchRequest({ query: raw });
    expect((variables as Record<string, unknown>).rawQuery).toBe(raw);
  });

  test('honors product, count and cursor overrides', () => {
    const { variables } = searchRequest({
      query: 'x',
      product: 'People',
      count: 50,
      cursor: 'CUR',
    });
    const v = variables as Record<string, unknown>;
    expect(v.product).toBe('People');
    expect(v.count).toBe(50);
    expect(v.cursor).toBe('CUR');
  });

  test('kv overrides variables and ft overrides features', () => {
    const { variables, features } = searchRequest({
      query: 'x',
      kv: { product: 'Media', count: 99 },
      ft: { responsive_web_graphql_timeline_navigation_enabled: false },
    });
    const v = variables as Record<string, unknown>;
    expect(v.product).toBe('Media');
    expect(v.count).toBe(99);
    expect(
      (features as Record<string, unknown>).responsive_web_graphql_timeline_navigation_enabled,
    ).toBe(false);
  });
});

describe('bookmarksRequest', () => {
  test('adds the bookmark timeline feature and promoted content', () => {
    const { variables, features } = bookmarksRequest({});
    expect((features as Record<string, unknown>).graphql_timeline_v2_bookmark_timeline).toBe(true);
    const v = variables as Record<string, unknown>;
    expect(v.includePromotedContent).toBe(true);
    expect(v.count).toBe(20);
  });

  test('passes count + cursor', () => {
    const { variables } = bookmarksRequest({ count: 100, cursor: 'C' });
    const v = variables as Record<string, unknown>;
    expect(v.count).toBe(100);
    expect(v.cursor).toBe('C');
  });

  // archive page-size parity (§9.5#7): twitter-cli pages at min(count-have+5, 40)
  test('archive page size: count:40 sets variables.count to 40', () => {
    const { variables } = bookmarksRequest({ count: 40 });
    expect((variables as Record<string, unknown>).count).toBe(40);
  });

  test('includes graphql_timeline_v2_bookmark_timeline:true at count:40', () => {
    const { features } = bookmarksRequest({ count: 40 });
    expect((features as Record<string, unknown>).graphql_timeline_v2_bookmark_timeline).toBe(true);
  });

  // §9.5#6: twitter-cli sends zero fieldToggles for Bookmarks — article content rides on
  // responsive_web_twitter_article_tweet_consumption_enabled (already in FEATURES).
  // Do NOT add withArticleRichContentState speculatively; verify with a real response first.
  test('has no fieldToggles by default (parity with twitter-cli §9.5#6)', () => {
    const req = bookmarksRequest({});
    expect(req.fieldToggles).toBeUndefined();
  });

  test('has no article fieldToggle at archive page size count:40', () => {
    const req = bookmarksRequest({ count: 40 });
    expect(req.fieldToggles).toBeUndefined();
  });
});

describe('userTweetsRequest', () => {
  test('defaults to UserTweets op with timeline flags', () => {
    const { variables, fieldToggles } = userTweetsRequest({ userId: '44196397' });
    const v = variables as Record<string, unknown>;
    expect(v.userId).toBe('44196397');
    expect(v.count).toBe(40);
    expect(v.includePromotedContent).toBe(false);
    expect(v.withVoice).toBe(true);
    expect(v.withV2Timeline).toBe(true);
    expect(fieldToggles).toEqual({ withArticlePlainText: false });
  });

  test('replies:true selects the UserTweetsAndReplies op (via graphqlUrl-able op)', () => {
    const a = userTweetsRequest({ userId: '1', replies: true });
    const b = userTweetsRequest({ userId: '1' });
    expect(a.op).toBe('UserTweetsAndReplies');
    expect(b.op).toBe('UserTweets');
    expect(graphqlUrl(a.op)).toContain('UserTweetsAndReplies');
  });
});

describe('userByScreenNameRequest', () => {
  test('uses screen_name + the user fieldToggles', () => {
    const { variables, fieldToggles } = userByScreenNameRequest({ screenName: 'jack' });
    const v = variables as Record<string, unknown>;
    expect(v.screen_name).toBe('jack');
    expect(v.withGrokTranslatedBio).toBe(false);
    expect(fieldToggles).toEqual({ withPayments: false, withAuxiliaryUserLabels: true });
  });
});

describe('tweetDetailRequest', () => {
  test('sets focalTweetId and passes cursor', () => {
    const { variables } = tweetDetailRequest({ focalTweetId: '20', cursor: 'C' });
    const v = variables as Record<string, unknown>;
    expect(v.focalTweetId).toBe('20');
    expect(v.cursor).toBe('C');
  });
});

describe('communityRequest / communityTweetsRequest', () => {
  test('communityRequest carries the communityId and FEATURES', () => {
    const { variables, features } = communityRequest({ communityId: '149' });
    expect((variables as Record<string, unknown>).communityId).toBe('149');
    expect(
      (features as Record<string, unknown>).responsive_web_graphql_timeline_navigation_enabled,
    ).toBe(FEATURES.responsive_web_graphql_timeline_navigation_enabled);
  });

  test('communityTweetsRequest sets the Community display location + ranking and passes cursor', () => {
    const { variables } = communityTweetsRequest({ communityId: '149', cursor: 'C' });
    const v = variables as Record<string, unknown>;
    expect(v.communityId).toBe('149');
    expect(v.displayLocation).toBe('Community');
    expect(v.rankingMode).toBe('Relevance');
    expect(v.withCommunity).toBe(true);
    expect(v.count).toBe(20);
    expect(v.cursor).toBe('C');
  });

  test('communityTweetsRequest honors a Recency ranking override', () => {
    const { variables } = communityTweetsRequest({ communityId: '1', rankingMode: 'Recency' });
    expect((variables as Record<string, unknown>).rankingMode).toBe('Recency');
  });
});

describe('likesRequest', () => {
  test('Likes op is present in OPS with the twitter-cli queryId', () => {
    expect(OPS.Likes.queryId).toBe('dv5-II7_Bup_PHish7p6fw');
    expect(OPS.Likes.operationName).toBe('Likes');
  });

  test('graphqlUrl for Likes builds the correct URL', () => {
    expect(graphqlUrl('Likes')).toBe('https://x.com/i/api/graphql/dv5-II7_Bup_PHish7p6fw/Likes');
  });

  test('likesRequest encodes userId, count defaults and all expected flags', () => {
    const { variables, features, fieldToggles } = likesRequest({ userId: '12345' });
    const v = variables as Record<string, unknown>;
    expect(v.userId).toBe('12345');
    expect(v.count).toBe(40);
    expect(v.includePromotedContent).toBe(false);
    expect(v.withClientEventToken).toBe(false);
    expect(v.withBirdwatchNotes).toBe(false);
    expect(v.withVoice).toBe(true);
    expect(v.withV2Timeline).toBe(true);
    expect(fieldToggles).toEqual({ withArticlePlainText: false });
    // features should include the base FEATURES blob
    expect(
      (features as Record<string, unknown>).responsive_web_graphql_timeline_navigation_enabled,
    ).toBe(FEATURES.responsive_web_graphql_timeline_navigation_enabled);
  });

  test('likesRequest passes count and cursor', () => {
    const { variables } = likesRequest({ userId: '1', count: 20, cursor: 'C' });
    const v = variables as Record<string, unknown>;
    expect(v.count).toBe(20);
    expect(v.cursor).toBe('C');
  });

  test('likesRequest without cursor omits cursor key', () => {
    const { variables } = likesRequest({ userId: '1' });
    expect((variables as Record<string, unknown>).cursor).toBeUndefined();
  });

  test('kv overrides variables and ft overrides features', () => {
    const { variables, features } = likesRequest({
      userId: '1',
      kv: { count: 99 },
      ft: { responsive_web_graphql_timeline_navigation_enabled: false },
    });
    expect((variables as Record<string, unknown>).count).toBe(99);
    expect(
      (features as Record<string, unknown>).responsive_web_graphql_timeline_navigation_enabled,
    ).toBe(false);
  });
});

describe('encodeParams', () => {
  test('is deterministic for the same input', () => {
    const req = {
      variables: { b: 2, a: 1 },
      features: { y: true, x: false },
    };
    expect(encodeParams(req)).toBe(encodeParams(req));
  });

  test('sorts keys so member order does not change output', () => {
    const a = encodeParams({ variables: { a: 1, b: 2 }, features: {} });
    const b = encodeParams({ variables: { b: 2, a: 1 }, features: {} });
    expect(a).toBe(b);
  });

  test('round-trips: parsing the variables param equals the input', () => {
    const variables = { rawQuery: 'from:jack', count: 20, product: 'Latest' };
    const qs = encodeParams({ variables, features: { x: true } });
    const params = new URLSearchParams(qs);
    const raw = params.get('variables');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw ?? '')).toEqual(variables);
  });

  test('does not start with a leading ?', () => {
    expect(encodeParams({ variables: {}, features: {} }).startsWith('?')).toBe(false);
  });

  test('encodes a known small case exactly', () => {
    const qs = encodeParams({ variables: { a: 1 }, features: { b: true } });
    expect(qs).toBe(
      `variables=${encodeURIComponent('{"a":1}')}&features=${encodeURIComponent('{"b":true}')}`,
    );
  });

  test('omits fieldToggles when absent and includes it when present', () => {
    const without = encodeParams({ variables: {}, features: {} });
    expect(without).not.toContain('fieldToggles');
    const withFt = encodeParams({ variables: {}, features: {}, fieldToggles: { z: false } });
    expect(withFt).toContain('fieldToggles');
  });
});
