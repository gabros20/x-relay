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
  /** @handle of the retweeter — set only when isRetweet is true (rich path). */
  retweetedBy?: string;
  conversationId?: string;
  /** Present when this tweet quotes another. */
  quoted?: Tweet;
  /** Full media objects — populated only in rich parse mode. Slim `media: MediaKind[]` stays as-is. */
  mediaItems?: MediaItem[];
  /** Article title + markdown — populated only in rich parse mode. */
  article?: ArticleBrief;
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

/** A brief representation of an X Article embedded in a tweet (archive use). */
export interface ArticleBrief {
  title: string;
  markdown: string;
}

/** A long-form X Article rendered to Markdown. */
export type Article = {
  id: string;
  title: string;
  markdown: string;
  url: string;
  author?: Author;
};

/** An X Community's metadata (the `community-info` command). */
export type Community = {
  id: string;
  name: string;
  description?: string;
  memberCount?: number;
  moderatorCount?: number;
  /** ISO timestamp (X reports created_at as epoch ms). */
  createdAt?: string;
  /** The viewer's role in the community (Member / Moderator / Admin / NonMember). */
  role?: string;
  joinPolicy?: string;
  topic?: string;
  rules?: string[];
  tags?: string[];
  creator?: Author;
  url: string;
};

// ── Archive ────────────────────────────────────────────────────────────────

/** A single tweet in the full-fidelity archive format. */
export interface ArchiveTweet {
  id: string;
  url: string;
  text: string;
  lang?: string;
  /** Raw timestamp as returned by X, e.g. "Wed Jun 10 16:06:30 +0000 2026". */
  createdAt?: string;
  /** ISO 8601, e.g. "2026-06-10T16:06:30+00:00". */
  createdAtISO?: string;
  /** Local time string, e.g. "2026-06-10 18:06". */
  createdAtLocal?: string;
  author: Author;
  metrics: Metrics;
  hashtags?: string[];
  mentions?: string[];
  urls?: string[];
  /** Rich media objects — {type, url, width?, height?, thumbnail?, bitrate?, durationMs?}. */
  media?: MediaItem[];
  isReply?: boolean;
  isRetweet?: boolean;
  isQuote?: boolean;
  /** @handle of the retweeter when isRetweet is true. */
  retweetedBy?: string;
  conversationId?: string;
  /** Quoted tweet, recursively archived (depth-limited). */
  quoted?: ArchiveTweet;
  /** Article title + markdown when the tweet links an X Article. */
  article?: ArticleBrief;
}

/** The top-level JSON envelope for an xrelay archive file. */
export interface ArchiveFile {
  schema: 'x-relay/archive@1';
  source: 'bookmarks';
  /** ISO timestamp of when the archive was generated. */
  generatedAt: string;
  count: number;
  /** Max tweet id present in the file (reference for display). */
  newestId?: string;
  /** Archived tweets, newest-bookmarked first. */
  tweets: ArchiveTweet[];
}
