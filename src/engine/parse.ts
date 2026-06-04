// Normalize X/Twitter's private GraphQL JSON into our clean domain types, plus
// cursor / end-detection for timelines. Pure — no I/O, no network. The engine's
// client.ts feeds raw JSON in; everything downstream consumes our domain types.
// Source of truth: docs/ENGINE-RESEARCH.md §5 (dual core/legacy, field map,
// pagination/end-detection) and §2 (timeline shape).

import type {
  Author,
  MediaKind,
  Metrics,
  ThreadResult,
  Tweet,
  TweetPage,
  UserProfile,
} from '../types.ts';

// ── Narrowing helpers ───────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A child object by key, or undefined when absent / not an object. */
function child(node: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = node[key];
  return isRecord(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Coerce a number or a numeric string ("1234") to a number, else undefined. */
function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * Recursive deep search collecting every value stored under `key` anywhere in a
 * nested object/array tree (port of twikit's `find_dict`). Lets the parser stay
 * robust to X's layout drift instead of hardcoding full JSON paths.
 *
 * @param findFirst when true, stop and return after the first match.
 */
export function findDict(obj: unknown, key: string, findFirst = false): unknown[] {
  const out: unknown[] = [];

  // Returns true once `findFirst` is satisfied, to unwind the recursion early.
  const walk = (node: unknown): boolean => {
    if (Array.isArray(node)) {
      return node.some(walk);
    }
    if (!isRecord(node)) return false;
    for (const [k, value] of Object.entries(node)) {
      if (k === key) {
        out.push(value);
        if (findFirst) return true;
      }
      if (walk(value)) return true;
    }
    return false;
  };

  walk(obj);
  return out;
}

// ── User normalization ──────────────────────────────────────────────────────

/**
 * Normalize a `user_results.result` node into a UserProfile. Reads the new
 * sub-object locations (`core`, `avatar`, `verification`, `profile_bio`,
 * `location`) with a `legacy` fallback so it works whether X populated `legacy`
 * or hoisted the fields out (docs/ENGINE-RESEARCH.md §5). Returns null for any
 * node that isn't a real user (e.g. `UserUnavailable`).
 */
export function parseUserResult(result: unknown): UserProfile | null {
  if (!isRecord(result)) return null;
  if (result.__typename !== undefined && result.__typename !== 'User') return null;

  const legacy = child(result, 'legacy');
  const core = child(result, 'core');

  const handle = asString(core?.screen_name) ?? asString(legacy?.screen_name);
  const id = asString(result.rest_id) ?? asString(legacy?.id_str);
  if (handle === undefined || id === undefined) return null;

  const name = asString(core?.name) ?? asString(legacy?.name) ?? handle;
  // Verification is the logical-OR of three independent signals (blue check,
  // the new `verification` block, legacy.verified) — any one true means verified.
  const verification = child(result, 'verification');
  const verified =
    asBool(result.is_blue_verified) === true ||
    asBool(verification?.verified) === true ||
    asBool(legacy?.verified) === true;

  const followers = asNumber(legacy?.followers_count) ?? asNumber(result.followers_count) ?? 0;
  const following = asNumber(legacy?.friends_count) ?? asNumber(result.friends_count) ?? 0;
  const tweets = asNumber(legacy?.statuses_count) ?? asNumber(result.statuses_count) ?? 0;

  const profile: UserProfile = {
    id,
    handle,
    name,
    verified,
    followers,
    following,
    tweets,
    url: `https://x.com/${handle}`,
  };
  applyUserOptionals(profile, result, legacy, core);
  return profile;
}

/** Populate bio/createdAt/location/avatar on a profile in place (sub-object then legacy). */
function applyUserOptionals(
  profile: UserProfile,
  result: Record<string, unknown>,
  legacy: Record<string, unknown> | undefined,
  core: Record<string, unknown> | undefined,
): void {
  const profileBio = child(result, 'profile_bio');
  const bio = asString(legacy?.description) ?? asString(profileBio?.description);
  if (bio !== undefined) profile.bio = bio;

  const createdAt = asString(core?.created_at) ?? asString(legacy?.created_at);
  if (createdAt !== undefined) profile.createdAt = createdAt;

  const locationObj = child(result, 'location');
  const location = asString(legacy?.location) ?? asString(locationObj?.location);
  if (location !== undefined) profile.location = location;

  const avatarObj = child(result, 'avatar');
  const avatar = asString(legacy?.profile_image_url_https) ?? asString(avatarObj?.image_url);
  if (avatar !== undefined) profile.avatar = avatar;
}

// ── Tweet normalization ─────────────────────────────────────────────────────

/** A UserProfile reduced to the embedded-author shape. */
function authorFromProfile(profile: UserProfile): Author {
  const author: Author = {
    id: profile.id,
    handle: profile.handle,
    name: profile.name,
    verified: profile.verified,
    followers: profile.followers,
  };
  if (profile.avatar !== undefined) author.avatar = profile.avatar;
  return author;
}

/** Pull a normalized author out of `result.core.user_results.result`. */
function parseAuthor(result: Record<string, unknown>): Author | null {
  const core = child(result, 'core');
  const userResults = core ? child(core, 'user_results') : undefined;
  const userNode = userResults ? userResults.result : undefined;
  const profile = parseUserResult(userNode);
  return profile ? authorFromProfile(profile) : null;
}

/** Long-form body from note_tweet, else legacy/hoisted full_text. */
function tweetText(result: Record<string, unknown>, legacy: Record<string, unknown> | undefined) {
  const note = child(result, 'note_tweet');
  const noteResults = note ? child(note, 'note_tweet_results') : undefined;
  const noteResult = noteResults ? child(noteResults, 'result') : undefined;
  const noteText = noteResult ? asString(noteResult.text) : undefined;
  if (noteText !== undefined) return noteText;
  return asString(legacy?.full_text) ?? asString(result.full_text) ?? '';
}

/** Views live OUTSIDE legacy on the result root (views.count), with ext_views fallback. */
function tweetViews(
  result: Record<string, unknown>,
  legacy: Record<string, unknown> | undefined,
): number | undefined {
  const views = child(result, 'views') ?? child(result, 'ext_views');
  const extFromLegacy = legacy ? child(legacy, 'ext_views') : undefined;
  return asNumber(views?.count) ?? asNumber(extFromLegacy?.count);
}

function tweetMetrics(
  result: Record<string, unknown>,
  legacy: Record<string, unknown> | undefined,
): Metrics {
  const pick = (key: string) => asNumber(legacy?.[key]) ?? asNumber(result[key]);
  const metrics: Metrics = {};
  const likes = pick('favorite_count');
  const retweets = pick('retweet_count');
  const replies = pick('reply_count');
  const quotes = pick('quote_count');
  const bookmarks = pick('bookmark_count');
  const views = tweetViews(result, legacy);
  if (likes !== undefined) metrics.likes = likes;
  if (retweets !== undefined) metrics.retweets = retweets;
  if (replies !== undefined) metrics.replies = replies;
  if (quotes !== undefined) metrics.quotes = quotes;
  if (bookmarks !== undefined) metrics.bookmarks = bookmarks;
  if (views !== undefined) metrics.views = views;
  return metrics;
}

/** Collect `field` strings from entities[arrayKey][].`field`. */
function entityStrings(
  entities: Record<string, unknown> | undefined,
  arrayKey: string,
  field: string,
) {
  const arr = entities?.[arrayKey];
  if (!Array.isArray(arr)) return undefined;
  const out: string[] = [];
  for (const item of arr) {
    if (isRecord(item)) {
      const value = asString(item[field]);
      if (value !== undefined) out.push(value);
    }
  }
  return out.length > 0 ? out : undefined;
}

const MEDIA_MAP: Record<string, MediaKind> = {
  photo: 'photo',
  video: 'video',
  animated_gif: 'gif',
};

function tweetMedia(extended: Record<string, unknown> | undefined): MediaKind[] | undefined {
  const arr = extended?.media;
  if (!Array.isArray(arr)) return undefined;
  const out: MediaKind[] = [];
  for (const item of arr) {
    if (isRecord(item)) {
      const kind = asString(item.type);
      if (kind !== undefined && kind in MEDIA_MAP) {
        const mapped = MEDIA_MAP[kind];
        if (mapped !== undefined) out.push(mapped);
      }
    }
  }
  return out.length > 0 ? out : undefined;
}

/** Read a `node.legacy?.X ?? node.X` field as a string (works hoisted or legacy). */
function dualString(
  result: Record<string, unknown>,
  legacy: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  return asString(legacy?.[key]) ?? asString(result[key]);
}

/** Populate the optional scalar + entity/media fields on a tweet in place. */
function applyTweetDetails(
  tweet: Tweet,
  result: Record<string, unknown>,
  legacy: Record<string, unknown> | undefined,
): void {
  const lang = dualString(result, legacy, 'lang');
  if (lang !== undefined) tweet.lang = lang;
  const createdAt = dualString(result, legacy, 'created_at');
  if (createdAt !== undefined) tweet.createdAt = createdAt;
  const conversationId = dualString(result, legacy, 'conversation_id_str');
  if (conversationId !== undefined) tweet.conversationId = conversationId;

  const entities = child(result, 'entities') ?? (legacy ? child(legacy, 'entities') : undefined);
  const extended =
    child(result, 'extended_entities') ?? (legacy ? child(legacy, 'extended_entities') : undefined);

  const hashtags = entityStrings(entities, 'hashtags', 'text');
  if (hashtags !== undefined) tweet.hashtags = hashtags;
  const mentions = entityStrings(entities, 'user_mentions', 'screen_name');
  if (mentions !== undefined) tweet.mentions = mentions;
  const urls = entityStrings(entities, 'urls', 'expanded_url');
  if (urls !== undefined) tweet.urls = urls;
  const media = tweetMedia(extended);
  if (media !== undefined) tweet.media = media;
}

/** Populate isReply/isRetweet/isQuote + the quoted-tweet recursion in place. */
function applyTweetRelations(
  tweet: Tweet,
  result: Record<string, unknown>,
  legacy: Record<string, unknown> | undefined,
): void {
  if (dualString(result, legacy, 'in_reply_to_status_id_str') !== undefined) tweet.isReply = true;

  const isRetweet =
    child(result, 'retweeted_status_result') !== undefined ||
    (legacy ? child(legacy, 'retweeted_status_result') !== undefined : false);
  if (isRetweet) tweet.isRetweet = true;

  const quoteId = dualString(result, legacy, 'quoted_status_id_str');
  const quotedNode =
    child(result, 'quoted_status_result') ??
    (legacy ? child(legacy, 'quoted_status_result') : undefined);
  if (quoteId !== undefined || quotedNode !== undefined) tweet.isQuote = true;
  if (quotedNode !== undefined) {
    const quoted = parseTweetResult(quotedNode.result);
    if (quoted !== null) tweet.quoted = quoted;
  }
}

/**
 * Normalize a `tweet_results.result` node into a Tweet. Unwraps
 * `TweetWithVisibilityResults` (→ `.tweet`), returns null for a `TweetTombstone`
 * (or any non-tweet). Reads every legacy field as `node.legacy?.X ?? node.X` so
 * it works whether legacy is populated or hoisted (docs/ENGINE-RESEARCH.md §5).
 */
export function parseTweetResult(result: unknown): Tweet | null {
  if (!isRecord(result)) return null;

  if (result.__typename === 'TweetWithVisibilityResults') {
    return parseTweetResult(result.tweet);
  }
  if (result.__typename === 'TweetTombstone') return null;

  const legacy = child(result, 'legacy');
  const id = asString(result.rest_id) ?? asString(legacy?.id_str);
  if (id === undefined) return null;

  const author = parseAuthor(result);
  if (author === null) return null;

  const tweet: Tweet = {
    id,
    url: `https://x.com/${author.handle}/status/${id}`,
    text: tweetText(result, legacy),
    author,
    metrics: tweetMetrics(result, legacy),
  };

  applyTweetDetails(tweet, result, legacy);
  applyTweetRelations(tweet, result, legacy);
  return tweet;
}

// ── Timeline / pagination ───────────────────────────────────────────────────

// Entry-id prefixes that carry tweets we want.
const TWEET_ENTRY_PREFIXES = [
  'tweet',
  'search-grid',
  'profile-conversation',
  'profile-grid', // UserMedia timeline: a module entry whose items[] hold the tweets
];
// Entry-id prefixes we always drop (cursors, ads, recommendations, modules-as-noise).
const DROP_ENTRY_PREFIXES = ['cursor-', 'promoted', 'who-to-follow', 'module-'];

function startsWithAny(value: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => value.startsWith(prefix));
}

/** Locate the first `instructions` array anywhere in the response (layout-drift safe). */
function locateInstructions(json: unknown): unknown[] {
  const found = findDict(json, 'instructions', true)[0];
  return Array.isArray(found) ? found : [];
}

/** Flatten every instruction's `entries` into one ordered list. */
function collectEntries(instructions: unknown[]): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  for (const instruction of instructions) {
    if (isRecord(instruction) && Array.isArray(instruction.entries)) {
      for (const entry of instruction.entries) {
        if (isRecord(entry)) entries.push(entry);
      }
    }
  }
  return entries;
}

/** The cursor value from a Bottom-cursor entry, else undefined. */
function entryBottomCursor(entry: Record<string, unknown>, entryId: string): string | undefined {
  const content = child(entry, 'content');
  const itemContent = content ? child(content, 'itemContent') : undefined;
  const cursorType = asString(content?.cursorType) ?? asString(itemContent?.cursorType);
  const isBottom =
    cursorType === 'Bottom' ||
    cursorType === 'ShowMoreThreads' ||
    entryId.startsWith('cursor-bottom') ||
    entryId.startsWith('cursor-showmore');
  if (!isBottom) return undefined;
  return asString(content?.value) ?? asString(itemContent?.value);
}

/** Every `tweet_results.result` node reachable under an entry (item or module items[]). */
function entryTweetNodes(entry: Record<string, unknown>): unknown[] {
  return findDict(entry, 'tweet_results').map((node) => (isRecord(node) ? node.result : undefined));
}

/**
 * Walk a timeline response into a TweetPage. Collects tweets from tweet/
 * search-grid/profile-conversation entries (including module `items[]`), sets
 * nextCursor from the Bottom cursor entry, drops cursor/promoted/who-to-follow/
 * module entries, de-dupes by id, and skips any tweet that fails to parse so one
 * bad node never kills the page (docs/ENGINE-RESEARCH.md §5).
 */
export function parseTimeline(json: unknown, _opts?: { instructionsPath?: string }): TweetPage {
  const entries = collectEntries(locateInstructions(json));
  const tweets: Tweet[] = [];
  const seen = new Set<string>();
  let nextCursor: string | undefined;

  for (const entry of entries) {
    const entryId = asString(entry.entryId) ?? '';

    const cursor = entryBottomCursor(entry, entryId);
    if (cursor !== undefined) nextCursor = cursor;

    if (startsWithAny(entryId, DROP_ENTRY_PREFIXES)) continue;
    if (!startsWithAny(entryId, TWEET_ENTRY_PREFIXES)) continue;

    for (const node of entryTweetNodes(entry)) {
      try {
        const tweet = parseTweetResult(node);
        if (tweet !== null && !seen.has(tweet.id)) {
          seen.add(tweet.id);
          tweets.push(tweet);
        }
      } catch {
        // One bad tweet never kills the page.
      }
    }
  }

  const page: TweetPage = { tweets };
  if (nextCursor !== undefined) page.nextCursor = nextCursor;
  return page;
}

/**
 * Parse a TweetDetail response into a ThreadResult: the tweet matching
 * focalTweetId is the root, the rest are replies, in entry order. Carries the
 * Bottom / ShowMoreThreads cursor as nextCursor.
 */
export function parseThread(json: unknown, focalTweetId: string): ThreadResult {
  const page = parseTimeline(json);
  const root = page.tweets.find((tweet) => tweet.id === focalTweetId);
  const replies = page.tweets.filter((tweet) => tweet.id !== focalTweetId);

  const result: ThreadResult = {
    root: root ?? {
      id: focalTweetId,
      url: `https://x.com/i/status/${focalTweetId}`,
      text: '',
      author: { id: '', handle: '', name: '', verified: false },
      metrics: {},
    },
    replies,
  };
  if (page.nextCursor !== undefined) result.nextCursor = page.nextCursor;
  return result;
}
