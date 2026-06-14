import type {
  Author,
  MediaItem,
  SearchProduct,
  SearchResult,
  ThreadResult,
  Tweet,
  TweetPage,
  UserPage,
  UserProfile,
} from '../types.ts';
import {
  type Engine,
  type EngineDeps,
  EngineError,
  type PageOpts,
  type SearchOpts,
  createEngine,
} from './index.ts';

const DEFAULT_BASE_URL = 'https://xquik.com';
const SEARCH_PATH = '/api/v1/x/tweets/search';
const USERS_PATH = '/api/v1/x/users';
const DEFAULT_TIMEOUT_MS = 30_000;
const BACKEND_ENV_VALUE = 'hermes-tweet';

export interface HermesTweetConfig {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  fallback?: Engine;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const str = String(value).trim();
    if (str.length > 0) return str;
  }
  return undefined;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.replaceAll(',', ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function stripHandle(handle: string): string {
  return handle
    .trim()
    .replace(/^@/, '')
    .replace(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//, '');
}

function trimBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function authHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (apiKey.startsWith('xq_')) headers['x-api-key'] = apiKey;
  else headers.authorization = `Bearer ${apiKey}`;
  return headers;
}

function queryType(product: SearchProduct | undefined): string | undefined {
  return product === 'Top' || product === 'Latest' ? product : undefined;
}

function findFirstObject(payload: unknown, keys: string[]): JsonObject | undefined {
  if (!isObject(payload)) return undefined;
  for (const key of keys) {
    const value = payload[key];
    if (isObject(value)) return value;
  }
  for (const key of ['data', 'result']) {
    const nested = payload[key];
    const found = findFirstObject(nested, keys);
    if (found !== undefined) return found;
  }
  return payload;
}

function extractRecords(payload: unknown, keys: string[]): JsonObject[] {
  if (Array.isArray(payload)) return payload.filter(isObject);
  if (!isObject(payload)) return [];
  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value)) return value.filter(isObject);
  }
  for (const key of ['data', 'result']) {
    const records = extractRecords(payload[key], keys);
    if (records.length > 0) return records;
  }
  return [];
}

function extractCursor(payload: unknown): string | undefined {
  if (!isObject(payload)) return undefined;
  return firstString(
    payload.nextCursor,
    payload.next_cursor,
    payload.cursor,
    isObject(payload.data) ? payload.data.nextCursor : undefined,
    isObject(payload.result) ? payload.result.nextCursor : undefined,
  );
}

function normalizeMedia(value: unknown): Tweet['media'] {
  const media = asArray(value)
    .map((item) => {
      const kind = isObject(item) ? (item.type ?? item.kind) : item;
      if (kind === 'photo' || kind === 'video' || kind === 'gif') return kind;
      if (kind === 'animated_gif') return 'gif';
      return undefined;
    })
    .filter((item): item is NonNullable<Tweet['media']>[number] => item !== undefined);
  return media.length > 0 ? media : undefined;
}

function normalizeAuthor(record: JsonObject, index: number): Author {
  const author = isObject(record.author) ? record.author : isObject(record.user) ? record.user : {};
  const handle = firstString(author.handle, author.username, author.screen_name) ?? 'unknown';
  const followers = toNumber(author.followers ?? author.followers_count ?? author.follower_count);
  const avatar = firstString(author.avatar, author.profile_image_url_https);
  return {
    id:
      firstString(record.author_id, record.authorId, author.id, author.rest_id) ??
      `hermes-author-${index + 1}`,
    handle,
    name: firstString(author.name, author.display_name, handle) ?? handle,
    verified: Boolean(author.verified ?? author.is_blue_verified),
    ...(followers !== undefined ? { followers } : {}),
    ...(avatar !== undefined ? { avatar } : {}),
  };
}

function setMetric(
  target: Tweet['metrics'],
  key: keyof Tweet['metrics'],
  ...values: unknown[]
): void {
  for (const value of values) {
    const parsed = toNumber(value);
    if (parsed === undefined) continue;
    target[key] = parsed;
    return;
  }
}

function normalizeMetrics(metrics: JsonObject, record: JsonObject): Tweet['metrics'] {
  const normalized: Tweet['metrics'] = {};
  setMetric(normalized, 'likes', metrics.likes, metrics.like_count, record.favorite_count);
  setMetric(normalized, 'retweets', metrics.retweets, metrics.retweet_count, record.retweet_count);
  setMetric(normalized, 'replies', metrics.replies, metrics.reply_count, record.reply_count);
  setMetric(normalized, 'quotes', metrics.quotes, metrics.quote_count, record.quote_count);
  setMetric(
    normalized,
    'bookmarks',
    metrics.bookmarks,
    metrics.bookmark_count,
    record.bookmark_count,
  );
  setMetric(normalized, 'views', metrics.views, metrics.view_count, record.views);
  return normalized;
}

function normalizeTweet(record: JsonObject, index: number): Tweet {
  const author = normalizeAuthor(record, index);
  const metrics = isObject(record.metrics)
    ? record.metrics
    : isObject(record.public_metrics)
      ? record.public_metrics
      : {};
  const id = firstString(record.id, record.tweet_id, record.tweetId, record.rest_id);
  const tweetId = id ?? `hermes-tweet-${index + 1}`;
  const url =
    firstString(record.url, record.tweet_url, record.tweetUrl) ??
    `https://x.com/${author.handle}/status/${tweetId}`;

  const tweet: Tweet = {
    id: tweetId,
    url,
    text: firstString(record.text, record.full_text, record.fullText) ?? '',
    author,
    metrics: normalizeMetrics(metrics, record),
  };
  const createdAt = firstString(record.createdAt, record.created_at, record.created);
  if (createdAt !== undefined) tweet.createdAt = createdAt;
  const lang = firstString(record.lang, record.language);
  if (lang !== undefined) tweet.lang = lang;
  const media = normalizeMedia(record.media);
  if (media !== undefined) tweet.media = media;
  return tweet;
}

function normalizeUser(payload: unknown, fallbackHandle: string): UserProfile | null {
  const record = findFirstObject(payload, ['user', 'profile']);
  if (record === undefined) return null;
  const handle =
    firstString(record.handle, record.username, record.screen_name, record.screenName) ??
    stripHandle(fallbackHandle);
  const id = firstString(record.id, record.user_id, record.userId, record.rest_id) ?? handle;
  return {
    id,
    handle,
    name: firstString(record.name, record.display_name, handle) ?? handle,
    bio: firstString(record.bio, record.description),
    verified: Boolean(record.verified ?? record.is_blue_verified),
    followers: toNumber(record.followers ?? record.followers_count ?? record.follower_count) ?? 0,
    following: toNumber(record.following ?? record.following_count ?? record.friends_count) ?? 0,
    tweets: toNumber(record.tweets ?? record.tweet_count ?? record.statuses_count) ?? 0,
    createdAt: firstString(record.createdAt, record.created_at, record.created),
    location: firstString(record.location),
    avatar: firstString(record.avatar, record.profile_image_url_https),
    url: firstString(record.url) ?? `https://x.com/${handle}`,
  };
}

function unsupported<T>(fallback: (() => Promise<T>) | undefined, command: string): Promise<T> {
  if (fallback !== undefined) return fallback();
  throw new EngineError(
    'UNSUPPORTED_BACKEND',
    `Hermes Tweet backend does not implement ${command}; use the default x-relay backend.`,
  );
}

export function createHermesTweetEngine(config: HermesTweetConfig): Engine {
  const apiKey = config.apiKey;
  const baseUrl = trimBaseUrl(config.baseUrl);
  const fetchImpl = config.fetchImpl ?? fetch;
  const fallback = config.fallback;

  async function request(path: string, params?: Record<string, string>): Promise<unknown> {
    if (!apiKey) {
      throw new EngineError(
        'AUTH_FAILED',
        'Hermes Tweet API key is required. Set HERMES_TWEET_API_KEY or XQUIK_API_KEY.',
      );
    }
    const url = new URL(`${baseUrl}${path}`);
    for (const [key, value] of Object.entries(params ?? {})) {
      url.searchParams.set(key, value);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, {
        headers: authHeaders(apiKey),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new EngineError(
          'FETCH_FAILED',
          `Hermes Tweet request failed with status ${response.status}.`,
          response.status,
        );
      }
      return payload;
    } catch (err) {
      if (err instanceof EngineError) throw err;
      throw new EngineError('FETCH_FAILED', err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    async search(query, opts?: SearchOpts): Promise<SearchResult> {
      const product = opts?.product ?? 'Top';
      const params: Record<string, string> = {
        q: query,
        ...(opts?.limit !== undefined ? { limit: String(opts.limit) } : {}),
        ...(queryType(product) !== undefined ? { queryType: queryType(product) as string } : {}),
      };
      const payload = await request(SEARCH_PATH, params);
      const page: TweetPage = {
        tweets: extractRecords(payload, ['tweets', 'data', 'results', 'items']).map(normalizeTweet),
      };
      const nextCursor = extractCursor(payload);
      if (nextCursor !== undefined) page.nextCursor = nextCursor;
      return { query, product, ...page };
    },

    async user(handle): Promise<UserProfile | null> {
      const target = stripHandle(handle);
      const payload = await request(`${USERS_PATH}/${encodeURIComponent(target)}`);
      return normalizeUser(payload, target);
    },

    userTweets(handle, opts) {
      return unsupported(
        fallback ? () => fallback.userTweets(handle, opts) : undefined,
        'user-posts',
      );
    },
    userMedia(handle, opts?: PageOpts) {
      return unsupported(
        fallback ? () => fallback.userMedia(handle, opts) : undefined,
        'user-media',
      );
    },
    bookmarks(opts?: PageOpts) {
      return unsupported(fallback ? () => fallback.bookmarks(opts) : undefined, 'bookmarks');
    },
    thread(id): Promise<ThreadResult> {
      return unsupported(fallback ? () => fallback.thread(id) : undefined, 'thread');
    },
    list(listId, opts?: PageOpts) {
      return unsupported(fallback ? () => fallback.list(listId, opts) : undefined, 'list');
    },
    followers(handle, opts?: PageOpts): Promise<UserPage> {
      return unsupported(
        fallback ? () => fallback.followers(handle, opts) : undefined,
        'followers',
      );
    },
    following(handle, opts?: PageOpts): Promise<UserPage> {
      return unsupported(
        fallback ? () => fallback.following(handle, opts) : undefined,
        'following',
      );
    },
    retweeters(tweetId, opts?: PageOpts): Promise<UserPage> {
      return unsupported(
        fallback ? () => fallback.retweeters(tweetId, opts) : undefined,
        'retweeters',
      );
    },
    likers(tweetId, opts?: PageOpts): Promise<UserPage> {
      return unsupported(fallback ? () => fallback.likers(tweetId, opts) : undefined, 'likers');
    },
    quoters(tweetId, opts?: SearchOpts) {
      return unsupported(fallback ? () => fallback.quoters(tweetId, opts) : undefined, 'quoters');
    },
    trends(opts) {
      return unsupported(fallback ? () => fallback.trends(opts) : undefined, 'trends');
    },
    article(tweetId) {
      return unsupported(fallback ? () => fallback.article(tweetId) : undefined, 'article');
    },
    media(tweetId): Promise<MediaItem[]> {
      return unsupported(fallback ? () => fallback.media(tweetId) : undefined, 'media');
    },
    community(communityId, opts?: PageOpts) {
      return unsupported(
        fallback ? () => fallback.community(communityId, opts) : undefined,
        'community',
      );
    },
    communityInfo(communityId) {
      return unsupported(
        fallback ? () => fallback.communityInfo(communityId) : undefined,
        'community-info',
      );
    },
    me() {
      return unsupported(fallback ? () => fallback.me() : undefined, 'me');
    },
  };
}

export function createEngineFromEnv(deps: EngineDeps): Engine {
  const local = createEngine(deps);
  if (process.env.XRELAY_BACKEND !== BACKEND_ENV_VALUE) return local;
  return createHermesTweetEngine({
    apiKey: process.env.HERMES_TWEET_API_KEY ?? process.env.XQUIK_API_KEY,
    baseUrl: process.env.HERMES_TWEET_BASE_URL ?? process.env.XQUIK_BASE_URL,
    fetchImpl: deps.fetchImpl,
    fallback: local,
  });
}
