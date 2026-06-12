# Archive branch — bringing twitter-cli's full-fidelity capture into xrelay

> Goal: give xrelay a second pipeline — **archive** — that captures bookmarks (and
> later: likes, a user's posts) at full fidelity, matching everything `twitter-cli`
> extracts, emitted in **xrelay-native rich** shape. The existing **research**
> pipeline (slim, ranking-oriented) is untouched.

## 1. The two-branch model

```
xrelay
├── research branch  (today — unchanged)        slim Tweet, ranking-oriented
│     search · thread · user · *-graphs · trends
│     bookmarks / my-posts  (slim local cache)
│
└── archive branch  (NEW)                        rich ArchiveTweet, full fidelity
      archive bookmarks   → rich JSON store, incremental, set-membership stop
```

Same auth (browser cookies), same GraphQL client, same pagination engine. The only
differences are: (a) a **rich parse mode** that keeps the heavy fields the slim path
drops, (b) a **rich serializer** (`ArchiveTweet`), (c) a **membership-based incremental
stop** correct for bookmark ordering.

## 2. twitter-cli archiving feature map (the source of truth)

Read file-by-file. Everything twitter-cli's archive output carries comes from
`parser.py` → `serialization.tweet_to_dict`. The complete feature set:

| # | Feature | twitter-cli source | What it produces |
|---|---------|--------------------|------------------|
| 1 | Rich media | `parser._extract_media` (legacy.extended_entities.media) | `[{type, url, width, height}]`; video → highest-bitrate mp4 variant |
| 2 | Author | `parser._extract_author` | `{id, name, screenName, profileImageUrl, verified}` |
| 3 | Article | `parser._parse_article` (article.article_results.result) | `articleTitle` + `articleText` (Draft.js content_state → Markdown) |
| 4 | Quoted tweet | `parser.parse_tweet_result` recursion (depth ≤ 2) | `quotedTweet{id, text, author{screenName, name}}` |
| 5 | Retweet unwrap | `parser.parse_tweet_result` (retweeted_status_result) | swaps in original tweet's content; `isRetweet`, `retweetedBy` |
| 6 | Long text | note_tweet full text | full `text` (no "Show more" truncation) |
| 7 | URLs | entities.urls[].expanded_url | `urls[]` |
| 8 | Metrics | legacy counters + views.count | `{likes, retweets, replies, quotes, views, bookmarks}` |
| 9 | Timestamps | `timeutil.format_iso8601` / `format_local_time` | `createdAt` + `createdAtISO` + `createdAtLocal` |
| 10 | lang | legacy.lang | `lang` |
| 11 | score | `filter.py` (only with `--filter`) | research-ranking artifact — **not archival** |
| 12 | Incremental | manual: fetch top-N, diff by id | newest-bookmarked first, stop on known ids |
| 13 | Bookmark folders | `client.fetch_bookmark_folders` + `cli bookmarks folders` | per-folder fetch — **out of scope v1** |

## 3. Gap analysis vs xrelay today

| Feature | xrelay status | Action |
|---------|---------------|--------|
| 1 Rich media | ✅ `extractTweetMedia` (parse-extra.ts:222) — richer (+thumbnail/bitrate/durationMs) | **reuse** |
| 2 Author | ✅ `parseAuthor` (parse.ts) — richer (+followers) | reuse, native naming (`handle`/`avatar`) |
| 3 Article | ✅ `parseArticle` (parse-extra.ts:370) — richer (inline links, images) | **reuse via refactor** (see §5.2) |
| 4 Quoted | ✅ `tweet.quoted` full recursion (parse.ts:306) | reuse (already richer than twitter-cli) |
| 5 Retweet unwrap | ⚠️ flag only — no content swap, no `retweetedBy` | **add** (parse.ts) |
| 6 Long text | ✅ `tweetText` note_tweet (parse.ts:172) | already |
| 7 URLs | ✅ `entityStrings(...'urls','expanded_url')` | already |
| 8 Metrics | ✅ identical six | already |
| 9 Timestamps | ⚠️ raw `createdAt` only | **add** `src/time.ts` (port 2 fns) |
| 10 lang | ✅ | already |
| 11 score | n/a (research cache has its own ranking) | skip — not archival |
| 12 Incremental | ✅ engine `paginate` + `stopAtId` — but id-watermark wrong for bookmark order | **add** membership stop |
| 13 Folders | ❌ | future |

**Net new code is small.** Three of the four "missing" rich fields already exist in
xrelay's codebase (media, article, quoted) — they're wired to the `media`/`article`
commands, not the bookmark path. Archive parity = **compose existing parsers** + two
small additions (timestamps, retweet unwrap) + a serializer + a command.

## 4. Output schema — xrelay-native rich (decided)

The archive file stays clean/native; the bookmarks app maps it on load.

```ts
// src/types.ts — additions
export interface ArticleBrief { title: string; markdown: string }

export interface ArchiveTweet {
  id: string;
  url: string;
  text: string;
  lang?: string;
  createdAt?: string;       // raw "Wed Jun 10 16:06:30 +0000 2026"
  createdAtISO?: string;    // NEW — "2026-06-10T16:06:30+00:00"
  createdAtLocal?: string;  // NEW — "2026-06-10 18:06"
  author: Author;           // {id, handle, name, verified, followers?, avatar?}
  metrics: Metrics;         // six counters
  hashtags?: string[];
  mentions?: string[];
  urls?: string[];
  media?: MediaItem[];      // RICH — {type, url, width?, height?, thumbnail?, bitrate?, durationMs?}
  isReply?: boolean;
  isRetweet?: boolean;
  isQuote?: boolean;
  retweetedBy?: string;     // NEW — @handle of the retweeter (when isRetweet)
  conversationId?: string;
  quoted?: ArchiveTweet;    // recursive (depth-limited)
  article?: ArticleBrief;   // NEW — title + markdown
}

export interface ArchiveFile {
  schema: 'x-relay/archive@1';
  source: 'bookmarks';
  generatedAt: string;      // ISO
  count: number;
  newestId?: string;        // max tweet id (reference)
  tweets: ArchiveTweet[];   // newest-bookmarked first
}
```

`Tweet` gains two **optional rich-only** fields so the rich parse can stash heavy data
without touching the slim research path:

```ts
// src/types.ts — Tweet additions (optional, populated only in rich parse mode)
mediaItems?: MediaItem[];   // full media objects (slim `media: MediaKind[]` stays as-is)
article?: ArticleBrief;     // article title + markdown
```

## 5. Implementation (all in ~/Documents/Personal/Projects/x-relay)

### 5.1 `src/time.ts` (NEW) — port twitter-cli/timeutil
- `formatIso8601(createdAt): string | undefined` — parse `"%a %b %d %H:%M:%S %z %Y"` → ISO.
- `formatLocal(createdAt): string | undefined` — → `"YYYY-MM-DD HH:mm"` in local TZ.
- Pure, tested. (Relative-time not needed for archive.)

### 5.2 `src/engine/parse-extra.ts` — split the article renderer
- Extract `renderArticleFromResult(tweetResultNode): ArticleBrief | null` — the
  `article_results → content_state → renderBlocks` core (lines 374–384), operating on a
  **tweet result node** (not a TweetResultByRestId envelope).
- `parseArticle(json)` keeps its signature and delegates to it (locate node, then render).
  Zero behavior change for the `article` command; new reuse for archive.

### 5.3 `src/engine/parse.ts` — rich parse mode + retweet unwrap
- `parseTweetResult(result, opts?: { rich?: boolean })`. When `rich`:
  - `tweet.mediaItems = extractTweetMedia(result)` (when non-empty).
  - `tweet.article = renderArticleFromResult(result)` (when present).
  - thread `rich` into the `quoted` recursion.
- `parseTimeline(json, opts?: { rich?: boolean })` threads `rich` to `parseTweetResult`.
- **Retweet unwrap** (parity with twitter-cli #5): when `retweeted_status_result` is
  present, parse the inner tweet as the content source and set `retweetedBy` =
  outer author handle. (Rare for bookmarks, included for true parity.)

### 5.4 `src/engine/ops.ts` — rich bookmark request
- `bookmarksRequest({ cursor, rich })`: when `rich`, add
  `fieldToggles: { withArticleRichContentState: true }` so the bookmark timeline carries
  article `content_state.blocks` (otherwise article text is absent). Slim path unchanged.

### 5.5 `src/engine/index.ts` — archive engine method
- Generalize `paginate` to accept an optional **membership stop**:
  `stop?: { isKnown: (id: string) => boolean; tolerance?: number }` — stop after
  `tolerance` (default 3) consecutive already-known ids. Keeps existing `stopAtId` for
  the research/sync path; archive uses `isKnown`.
- `engine.archiveBookmarks({ limit, knownIds, full }): Promise<ArchiveTweet[]>`:
  - paginates `Bookmarks` with `rich:true` parse,
  - default: membership stop on `knownIds`; `full`: no stop, page to `limit`,
  - returns `ArchiveTweet[]` via the serializer (§5.6), newest-first.

### 5.6 `src/archive.ts` (NEW) — serializer + file store
- `toArchiveTweet(tweet: Tweet): ArchiveTweet` — reshape: native author, `media` from
  `mediaItems` (fallback: map slim kinds w/o url), `createdAtISO`/`Local` via `src/time`,
  recursive `quoted`, `article`, `retweetedBy`.
- `loadArchive(path): ArchiveFile | null`, `saveArchive(path, file)` (pretty JSON).
- `mergeArchive(existing, fresh): { file, added }` — prepend fresh (newest-first),
  dedup by id (fresh wins → refreshes metrics), recompute `count`/`newestId`.

### 5.7 `src/commands/registry.ts` + runner + dispatch
- Registry entry:
  ```
  archive   cost: medium — incremental
  summary:  Full-fidelity capture of your bookmarks to a rich JSON archive.
  usage:    xrelay archive bookmarks [--out <file.json>] [--limit N] [--full] [--stdout]
  ```
- `runArchive(engine, { target:'bookmarks', out, limit, full, stdout })` in runners.ts:
  - load existing `--out` (if any) → `knownIds`,
  - `engine.archiveBookmarks({ knownIds, full, limit })`,
  - merge + save (or print when `--stdout`),
  - envelope: `{ source, out, added, total, newestId }`.
- Wire flag parsing in `src/commands/index.ts` (mirror `sync`/`bookmarks`).

### 5.8 Skill + build
- `bun run generate` regenerates `src/generated/skill.ts` + SKILL.md (archive shows in help).
- Tests (`tests/`): fixture a raw bookmark page incl. photo, video, article, quoted,
  retweet → assert `ArchiveTweet` carries media URLs+dims, article markdown, quoted,
  retweetedBy, ISO/local. Time + merge unit tests. Membership-stop test.
- `bun run check` (typecheck + lint + test) → `bun run build` (tsup).
- Version bump + publish (semantic-release wired): the global `xrelay` gets `archive`.

## 6. Incremental strategy (correct for bookmark ordering)

Bookmarks list **newest-bookmarked first**, NOT by tweet id. So:
- **Default (incremental):** page from the top, collect any id not in `knownIds`, stop
  after 3 consecutive known ids (tolerance absorbs interleaving). Correctly captures a
  freshly-bookmarked *old* tweet (low id, top of list) that an id-watermark would miss.
- **`--full`:** ignore `knownIds`, page up to `--limit`, dedup — full rebuild / repair.
- Re-bookmarked tweets dedup by id (fresh wins, refreshes metrics, keeps newest position).

## 7. Downstream — bookmarks app consumption

The app maps `ArchiveTweet` → its `BookmarkPost` at load (in `lib/data-worker.ts`):
`author.handle→screenName`, `avatar→profileImageUrl`, `media MediaItem→{type,url,width,height}`,
`quoted→quotedTweet`, `article→articleTitle/articleText(markdown)`, timestamps pass through.

Then the bookmarks-app sync becomes:
```
xrelay archive bookmarks --out public/data/all-bookmarks.json   # rich, incremental
node scripts/embed-new.mjs                                        # embed only new posts
```
No twitter-cli dependency anywhere — **xrelay alone** does fetch + rich archive + incremental.

## 8. Out of scope (v1)

- Bookmark **folders** (twitter-cli has them; add later as `archive bookmarks --folder <id>`).
- `archive likes` / `archive user <handle>` (same machinery; trivial follow-ups).
- `score` (research-ranking artifact, not archival).
- Server-side scheduling/CI (cookies are local-browser only).
```

## 9.5 Second-pass review — gaps found & corrections

A line-by-line re-read of twitter-cli (`client._fetch_timeline`, `graphql.py`,
`parser._extract_media`) against xrelay surfaced 9 items. Two are latent xrelay bugs.

### Latent bugs in xrelay (must fix for a non-flaky archive)

1. **Unbounded quoted-tweet recursion.** `parse.ts` recurses into `quoted_status_result`
   with **no depth guard**; twitter-cli caps at `depth > 2`. A cyclic/deeply-nested quote
   chain (rare but real) → stack blowup. **Fix:** thread a `depth` param through
   `parseTweetResult`, cap at 2 (parity), applies in rich mode at minimum.

2. **Video/GIF media dropped when no mp4 variant.** xrelay `videoItem`/`gifItem` return
   `null` when there's no mp4 variant → the media item vanishes. twitter-cli falls back to
   `media_url_https`. **Fix:** fall back to `media_url_https` as the url so the item (and its
   thumbnail/dims) is never lost. Improves the `media` command too.

### Parity corrections to the parse

3. **Video/GIF missing width/height.** `videoItem`/`gifItem` set url/bitrate/thumbnail/
   durationMs but **not** dimensions; twitter-cli sets `original_info.width/height` for all
   media kinds. **Fix:** add `...mediaDimensions(media)` to video + gif builders (the app
   uses these for aspect ratio). Benefits `media` command too.

4. **Retweet unwrap ordering (explicit).** twitter-cli, when `retweeted_status_result` is
   present, swaps `actual_data/actual_legacy/actual_user` to the **inner** tweet, then
   extracts text/media/urls/metrics/quoted/article **from the unwrapped node**, and sets
   `retweetedBy = outer author handle`. §5.3 must unwrap **first**, then extract everything
   from the unwrapped node — not extract from the outer then patch.

5. **`created_at` parsing must be explicit.** Parse `"%a %b %d %H:%M:%S %z %Y"` with an
   explicit parser (don't trust `new Date(str)` across locales/runtimes). On parse failure,
   pass through the raw string (twitter-cli's behavior). Covered by `src/time.ts` tests.

### Request / pagination corrections

6. **No article fieldToggle needed for parity (correction to §5.4).** twitter-cli's
   `fetch_bookmarks` sends **zero fieldToggles** yet gets article `content_state.blocks` —
   article content rides on the `responsive_web_twitter_article_tweet_consumption_enabled`
   feature (xrelay already sets it). So §5.4 is **optional**: only add
   `withArticleRichContentState: true` if we want xrelay's inline-link/image richness *and*
   a real bookmark response confirms the timeline honors it. **Verify with a captured
   response before adding** — don't add speculatively.

7. **Page size + polite pacing.** twitter-cli pages at `min(count-have+5, 40)` (X's 40 cap)
   and **sleeps with jitter between pages**. xrelay `bookmarksRequest` defaults `count: 20`
   and `paginate` has **no inter-page delay** — it leans on multi-account lane failover.
   A single-account `--full` over ~5k bookmarks (~125 pages) risks `RATE_LIMITED`. **Fix:**
   archive uses page `count: 40`; add an optional inter-page delay (e.g. 300–800ms jitter)
   on the archive path for large/full runs. Incremental runs (small N) won't hit this.

### Semantics to pin (so it's not flaky)

8. **Un-bookmark pruning.** Incremental append **never removes** tweets you've since
   un-bookmarked (twitter-cli has the same blind spot unless the script replaces the file).
   **Decision:** `--full` does a complete re-page; add `--prune` so `--full --prune` replaces
   the file with exactly the current bookmark set (drops un-bookmarked). Default incremental
   = add-only (documented).

9. **Envelope-key contract with the app.** Archive emits
   `{schema, source, generatedAt, count, newestId, tweets:[ArchiveTweet]}`. The bookmarks app
   today reads `payload.data` (`build-search-index.mjs`, `data-worker.ts`). **Decision:** the
   app normalizes on load — read `payload.tweets ?? payload.data`, then map each
   `ArchiveTweet → BookmarkPost`. Pin this in the §7 mapper so the two repos agree on the
   contract. (Alternative — emit under `data` — rejected: `tweets` is xrelay-native and the
   per-record map is needed regardless.)

**Net:** items 1–4 are small, surgical parser fixes (and improve existing commands); 5–7 are
correctness/robustness; 8–9 are contract decisions. None change the architecture — they make
it sound. Build order below absorbs them.

## 10. Build order

1. `src/time.ts` (explicit `%a %b %d %H:%M:%S %z %Y` parse, raw passthrough on fail) + tests [§9.5#5].
2. parse-extra fixes: video/gif `mediaDimensions` + no-mp4 `media_url_https` fallback [§9.5#2,#3];
   split `renderArticleFromResult` (no behavior change).
3. parse.ts: rich mode; **depth-capped** quoted recursion [§9.5#1]; retweet **unwrap-first** then
   extract from unwrapped node + `retweetedBy` [§9.5#4] + tests.
4. ops.ts: archive bookmark request page `count: 40` [§9.5#7]; article fieldToggle only if a
   captured response proves it's needed [§9.5#6].
5. engine `archiveBookmarks` + membership stop in `paginate` + optional inter-page jitter for
   `--full` [§9.5#7] + tests.
6. `src/archive.ts` serializer/store + merge; `--full --prune` replace semantics [§9.5#8] + tests.
7. registry + runner + dispatch (`--out --limit --full --prune --stdout`); `bun run generate`.
8. `bun run check && bun run build`; smoke `xrelay archive bookmarks --out /tmp/a.json` twice
   (second = `+0`); inspect a record for media url+dims, article markdown, quoted, retweetedBy, ISO/local.
9. Version + publish.
10. Bookmarks app: read `payload.tweets ?? payload.data` + `ArchiveTweet`→`BookmarkPost` mapper in
    data-worker [§9.5#9]; `embed-new.mjs`; wire `npm run sync`.
