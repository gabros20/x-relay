// Externalized GraphQL operation config + request-building helpers for X/Twitter's
// private GraphQL surface. See docs/ENGINE-RESEARCH.md §2. No I/O here — pure config +
// pure request shaping. The network driver (client.ts) consumes these.
//
// URL shape: https://x.com/i/api/graphql/{queryId}/{OperationName}
// Reads are GET with variables / features / fieldToggles JSON-stringified into query
// params (see encodeParams). Builders replicate twscrape's kv/ft override ergonomics.

/**
 * Operation name → { queryId, operationName }. Values are the twscrape mid-2026
 * snapshot from ENGINE-RESEARCH.md §2.
 *
 * IMPORTANT: query-ids ROTATE. They live here in config, never hardcoded in logic.
 * A `(336) features cannot be null` (or a 404 on the URL) means the hashes drifted —
 * refresh this config from the web bundle.
 */
export const OPS = {
  SearchTimeline: { queryId: 'Yw6L66Pw54NHKuq4Dp7b4Q', operationName: 'SearchTimeline' },
  UserByScreenName: { queryId: 'IGgvgiOx4QZndDHuD3x9TQ', operationName: 'UserByScreenName' },
  UserByRestId: { queryId: 'VQfQ9wwYdk6j_u2O4vt64Q', operationName: 'UserByRestId' },
  UserTweets: { queryId: '36rb3Xj3iJ64Q-9wKDjCcQ', operationName: 'UserTweets' },
  UserTweetsAndReplies: {
    queryId: 'D5eKzDa5ZoJuC1TCeAXbWA',
    operationName: 'UserTweetsAndReplies',
  },
  UserMedia: { queryId: '9EovraBTXJYGSEQXZqlLmQ', operationName: 'UserMedia' },
  Bookmarks: { queryId: 'XD0ViOeSOW4YoeNTGjVaYw', operationName: 'Bookmarks' },
  TweetDetail: { queryId: 'oCon7R-cgWRFy6EfZjaKfg', operationName: 'TweetDetail' },
  Followers: { queryId: '_orfRBQae57vylFPH0Huhg', operationName: 'Followers' },
  Following: { queryId: 'F42cDX8PDFxkbjjq6JrM2w', operationName: 'Following' },
  ListLatestTweetsTimeline: {
    queryId: '7UuJsFvnWuZo0HmxrzU42Q',
    operationName: 'ListLatestTweetsTimeline',
  },
  Retweeters: { queryId: 'TZsWuSj7vGmncVnq7KWDUQ', operationName: 'Retweeters' },
  Favoriters: { queryId: 'LLkw5EcVutJL6y-2gkz22A', operationName: 'Favoriters' },
  GenericTimelineById: { queryId: '_dGVIf1cY6xFanFNPsAzPQ', operationName: 'GenericTimelineById' },
  TweetResultByRestId: { queryId: 'Xl5pC_lBk_gcO2ItU39DQw', operationName: 'TweetResultByRestId' },
  CommunityByRestId: { queryId: 'vLS7mhOqMLtGZdXqFP1DEg', operationName: 'CommunityByRestId' },
  CommunityTweetsTimeline: {
    queryId: 'pXYASW5kVylF3YMrGJovLg',
    operationName: 'CommunityTweetsTimeline',
  },
} as const satisfies Record<string, { queryId: string; operationName: string }>;

export type OpName = keyof typeof OPS;

/**
 * The ~37-key GraphQL feature flags blob (twscrape `GQL_FEATURES` snapshot).
 *
 * IMPORTANT: these flags ROTATE. X rejects requests with missing/unknown keys with
 * `(336) The following features cannot be null`. Treat that response as a loud,
 * actionable failure ("feature drift — refresh ops config"), never silent — and
 * refresh this blob from the web bundle (don't hand-curate keys).
 */
export const FEATURES: Record<string, boolean> = {
  rweb_video_screen_enabled: false,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: true,
  responsive_web_jetfuel_frame: false,
  responsive_web_grok_share_attachment_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  responsive_web_grok_show_grok_translated_post: false,
  responsive_web_grok_analysis_button_from_backend: true,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_grok_image_annotation_enabled: true,
  responsive_web_grok_imagine_annotation_enabled: true,
  responsive_web_grok_community_note_auto_translation_is_enabled: false,
  payments_enabled: false,
  hidden_profile_subscriptions_enabled: true,
  subscriptions_verification_info_is_identity_verified_enabled: true,
  subscriptions_verification_info_verified_since_enabled: true,
  responsive_web_enhance_cards_enabled: false,
};

/** The query string URL for a GraphQL operation (no params). */
export function graphqlUrl(op: OpName): string {
  const { queryId, operationName } = OPS[op];
  return `https://x.com/i/api/graphql/${queryId}/${operationName}`;
}

type Vars = Record<string, unknown>;
type Feats = Record<string, boolean>;

export interface BuiltRequest {
  variables: Vars;
  features: Feats;
  fieldToggles?: Vars;
}

/** A built request that also names the op it targets (for url resolution). */
interface OpRequest extends BuiltRequest {
  op: OpName;
}

interface Overrides {
  /** Extra/override variables merged on top of the builder defaults. */
  kv?: Vars;
  /** Override feature flags merged on top of FEATURES (+ any builder extras). */
  ft?: Feats;
}

function withCursor(base: Vars, cursor?: string): Vars {
  return cursor === undefined ? base : { ...base, cursor };
}

// --- SearchTimeline ---------------------------------------------------------

export type SearchProduct = 'Top' | 'Latest' | 'Media' | 'People';

export interface SearchParams extends Overrides {
  query: string;
  count?: number;
  product?: SearchProduct;
  cursor?: string;
}

export function searchRequest(params: SearchParams): BuiltRequest {
  const { query, count = 20, product = 'Latest', cursor, kv, ft } = params;
  const variables: Vars = withCursor(
    { rawQuery: query, count, querySource: 'typed_query', product },
    cursor,
  );
  return {
    variables: { ...variables, ...kv },
    features: { ...FEATURES, ...ft },
    fieldToggles: { withArticleRichContentState: false },
  };
}

// --- Bookmarks --------------------------------------------------------------

export interface BookmarksParams extends Overrides {
  count?: number;
  cursor?: string;
}

export function bookmarksRequest(params: BookmarksParams): BuiltRequest {
  const { count = 20, cursor, kv, ft } = params;
  const variables = withCursor({ count, includePromotedContent: true }, cursor);
  // No fieldToggles set: twitter-cli sends zero fieldToggles for Bookmarks and still receives
  // article content_state.blocks — article content rides on the already-set feature flag
  // responsive_web_twitter_article_tweet_consumption_enabled (§9.5#6). Do NOT add
  // withArticleRichContentState speculatively; verify with a captured bookmark response first.
  return {
    variables: { ...variables, ...kv },
    features: { ...FEATURES, graphql_timeline_v2_bookmark_timeline: true, ...ft },
  };
}

// --- UserTweets / UserTweetsAndReplies --------------------------------------

export interface UserTweetsParams extends Overrides {
  userId: string;
  count?: number;
  cursor?: string;
  replies?: boolean;
}

export function userTweetsRequest(params: UserTweetsParams): OpRequest {
  const { userId, count = 40, cursor, replies = false, kv, ft } = params;
  const op: OpName = replies ? 'UserTweetsAndReplies' : 'UserTweets';
  const variables = withCursor(
    {
      userId,
      count,
      includePromotedContent: false,
      withQuickPromoteEligibilityTweetFields: true,
      withVoice: true,
      withV2Timeline: true,
    },
    cursor,
  );
  return {
    op,
    variables: { ...variables, ...kv },
    features: { ...FEATURES, ...ft },
    fieldToggles: { withArticlePlainText: false },
  };
}

// --- UserByScreenName -------------------------------------------------------

export interface UserByScreenNameParams extends Overrides {
  screenName: string;
}

export function userByScreenNameRequest(params: UserByScreenNameParams): BuiltRequest {
  const { screenName, kv, ft } = params;
  return {
    variables: { screen_name: screenName, withGrokTranslatedBio: false, ...kv },
    features: { ...FEATURES, ...ft },
    fieldToggles: { withPayments: false, withAuxiliaryUserLabels: true },
  };
}

// --- TweetDetail ------------------------------------------------------------

export interface TweetDetailParams extends Overrides {
  focalTweetId: string;
  cursor?: string;
}

export function tweetDetailRequest(params: TweetDetailParams): BuiltRequest {
  const { focalTweetId, cursor, kv, ft } = params;
  const variables = withCursor(
    {
      focalTweetId,
      with_rux_injections: false,
      rankingMode: 'Relevance',
      includePromotedContent: true,
      withCommunity: true,
      withQuickPromoteEligibilityTweetFields: true,
      withBirdwatchNotes: true,
      withVoice: true,
    },
    cursor,
  );
  return {
    variables: { ...variables, ...kv },
    features: { ...FEATURES, ...ft },
    fieldToggles: { withArticleRichContentState: false, withArticlePlainText: false },
  };
}

// --- UserMedia --------------------------------------------------------------

export interface UserMediaParams extends Overrides {
  userId: string;
  count?: number;
  cursor?: string;
}

export function userMediaRequest(params: UserMediaParams): BuiltRequest {
  const { userId, count = 40, cursor, kv, ft } = params;
  const variables = withCursor(
    {
      userId,
      count,
      includePromotedContent: false,
      withClientEventToken: false,
      withBirdwatchNotes: false,
      withVoice: true,
      withV2Timeline: true,
    },
    cursor,
  );
  return {
    variables: { ...variables, ...kv },
    features: { ...FEATURES, ...ft },
    fieldToggles: { withArticlePlainText: false },
  };
}

// --- ListLatestTweetsTimeline -----------------------------------------------

export interface ListParams extends Overrides {
  listId: string;
  count?: number;
  cursor?: string;
}

export function listRequest(params: ListParams): BuiltRequest {
  const { listId, count = 40, cursor, kv, ft } = params;
  const variables = withCursor({ listId, count }, cursor);
  return {
    variables: { ...variables, ...kv },
    features: { ...FEATURES, ...ft },
    fieldToggles: { withArticleRichContentState: false },
  };
}

// --- Followers / Following / Retweeters / Favoriters (user-list timelines) ---

export interface UserListParams extends Overrides {
  /** userId for Followers/Following; tweetId for Retweeters/Favoriters. */
  id: string;
  count?: number;
  cursor?: string;
}

/** Shared builder for the user-list timelines. The caller picks the op. */
export function userListRequest(kind: 'user' | 'tweet', params: UserListParams): BuiltRequest {
  const { id, count = 20, cursor, kv, ft } = params;
  const idKey = kind === 'user' ? 'userId' : 'tweetId';
  const variables = withCursor({ [idKey]: id, count, includePromotedContent: true }, cursor);
  return {
    variables: { ...variables, ...kv },
    features: { ...FEATURES, ...ft },
  };
}

// --- GenericTimelineById (trends) -------------------------------------------

/** Stable category timeline tokens (twscrape). The default `trending` covers most cases. */
export const TREND_TIMELINES: Record<string, string> = {
  trending: 'VGltZWxpbmU6DAC2CwABAAAACHRyZW5kaW5nAAA',
  news: 'VGltZWxpbmU6DAC2CwABAAAABG5ld3MAAA',
  sport: 'VGltZWxpbmU6DAC2CwABAAAABnNwb3J0cwAA',
  entertainment: 'VGltZWxpbmU6DAC2CwABAAAADWVudGVydGFpbm1lbnQAAA',
};

export interface TrendsParams extends Overrides {
  timelineId?: string;
  count?: number;
  cursor?: string;
}

export function trendsRequest(params: TrendsParams = {}): BuiltRequest {
  const { timelineId = TREND_TIMELINES.trending, count = 20, cursor, kv, ft } = params;
  const variables = withCursor(
    { timelineId, count, withQuickPromoteEligibilityTweetFields: true },
    cursor,
  );
  return {
    variables: { ...variables, ...kv },
    features: { ...FEATURES, ...ft },
  };
}

// --- TweetResultByRestId (article / single tweet w/ rich content) -----------

export interface TweetResultParams extends Overrides {
  tweetId: string;
}

export function tweetResultRequest(params: TweetResultParams): BuiltRequest {
  const { tweetId, kv, ft } = params;
  return {
    variables: {
      tweetId,
      withCommunity: false,
      includePromotedContent: false,
      withVoice: false,
      ...kv,
    },
    features: { ...FEATURES, ...ft },
    fieldToggles: { withArticleRichContentState: true, withArticlePlainText: true },
  };
}

// --- CommunityByRestId / CommunityTweetsTimeline ----------------------------

export interface CommunityParams extends Overrides {
  communityId: string;
}

/** Community metadata (name, description, member counts, rules, creator). */
export function communityRequest(params: CommunityParams): BuiltRequest {
  const { communityId, kv, ft } = params;
  return {
    variables: { communityId, ...kv },
    features: { ...FEATURES, ...ft },
  };
}

export type CommunityRanking = 'Relevance' | 'Recency';

export interface CommunityTweetsParams extends Overrides {
  communityId: string;
  count?: number;
  cursor?: string;
  rankingMode?: CommunityRanking;
}

/** The tweets feed of a community. Defaults to the Relevance ranking X shows on the web. */
export function communityTweetsRequest(params: CommunityTweetsParams): BuiltRequest {
  const { communityId, count = 20, cursor, rankingMode = 'Relevance', kv, ft } = params;
  const variables = withCursor(
    { communityId, count, displayLocation: 'Community', rankingMode, withCommunity: true },
    cursor,
  );
  return {
    variables: { ...variables, ...kv },
    features: { ...FEATURES, ...ft },
  };
}

// --- Param encoding ---------------------------------------------------------

/** Stable JSON.stringify with sorted keys (deterministic param output). */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const body = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Encode a request into a deterministic query string (no leading `?`). Each of
 * variables / features / fieldToggles is JSON-stringified into a single param with a
 * stable (sorted) key order so identical input always yields identical output.
 */
export function encodeParams(req: {
  variables: object;
  features: object;
  fieldToggles?: object;
}): string {
  const params = new URLSearchParams();
  params.set('variables', stableStringify(req.variables));
  params.set('features', stableStringify(req.features));
  if (req.fieldToggles !== undefined) {
    params.set('fieldToggles', stableStringify(req.fieldToggles));
  }
  return params.toString();
}
