// ─── x-relay shared types ─────────────────────────────────────────────────
// The JSON envelope (mirrors youtube-relay-mcp) + the normalized X domain
// shapes the engine emits. The engine is the only module that touches the
// network; everything downstream consumes these types.

// ── Envelope ────────────────────────────────────────────────────────────────

export type Ok<T> = { ok: true; command: string; data: T };

export type Err = {
  ok: false;
  command: string;
  error: { code: string; message: string; hint?: string };
};

export type Envelope<T> = Ok<T> | Err;

// ── Domain ────────────────────────────────────────────────────────────────

/** A tweet's author, as it appears embedded in a tweet result. */
export type Author = {
  id: string;
  handle: string;
  name: string;
  verified: boolean;
  followers?: number;
  avatar?: string;
};

/** Engagement counters — all optional because X omits some in some contexts. */
export type Metrics = {
  likes?: number;
  retweets?: number;
  replies?: number;
  quotes?: number;
  bookmarks?: number;
  views?: number;
};

export type MediaKind = 'photo' | 'video' | 'gif';

/** A single tweet, normalized. The unit returned by search / timelines. */
export type Tweet = {
  id: string;
  url: string;
  text: string;
  lang?: string;
  createdAt?: string;
  author: Author;
  metrics: Metrics;
  hashtags?: string[];
  mentions?: string[];
  urls?: string[];
  media?: MediaKind[];
  isReply?: boolean;
  isRetweet?: boolean;
  isQuote?: boolean;
  conversationId?: string;
  /** Present when this tweet quotes another. */
  quoted?: Tweet;
};

/** A full user profile (the `user` command). */
export type UserProfile = {
  id: string;
  handle: string;
  name: string;
  bio?: string;
  verified: boolean;
  followers: number;
  following: number;
  tweets: number;
  createdAt?: string;
  location?: string;
  avatar?: string;
  url: string;
};

/** A paginated set of tweets (search / timeline output). */
export type TweetPage = {
  tweets: Tweet[];
  nextCursor?: string;
};

/** A search result, carrying back the query context. */
export type SearchResult = TweetPage & {
  query: string;
  product: SearchProduct;
};

/** A tweet plus its reply thread (the `thread` command). */
export type ThreadResult = {
  root: Tweet;
  replies: Tweet[];
  nextCursor?: string;
};

export type SearchProduct = 'Top' | 'Latest' | 'Media' | 'People';

/** A paginated set of users (followers / following / retweeters / likers). */
export type UserPage = {
  users: UserProfile[];
  nextCursor?: string;
};

/** A trending topic. */
export type Trend = {
  name: string;
  rank?: number;
  /** Volume blurb as X reports it, e.g. "42.1K posts". */
  volume?: string;
  url?: string;
};

/** A downloadable media asset attached to a tweet. */
export type MediaItem = {
  type: MediaKind;
  url: string;
  thumbnail?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  bitrate?: number;
};

/** A long-form X Article rendered to Markdown. */
export type Article = {
  id: string;
  title: string;
  markdown: string;
  url: string;
  author?: Author;
};
