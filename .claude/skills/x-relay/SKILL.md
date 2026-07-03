# x-relay

A **read + archive + write tool for X/Twitter** for AI agents — a CLI (`xrelay`), an MCP server, and this skill.
Cast a wide net with live search, rank candidates cheaply on engagement/recency metadata, and read full
threads only for the finalists. Cookies are **auto-extracted from your local browser** (Arc/Chrome/Brave/Edge
on macOS) — no manual setup. No paid X API.

The tool covers three surfaces: **read** (search / user / timeline / thread / bookmarks / feed), **archive**
(full-fidelity capture to rich JSON files), and **write** (post / reply / quote / like / bookmark / retweet /
follow / delete). YOU compose the strategy. This skill gives the **recommended funnel** first, then a
per-command reference with cost so you can deviate intelligently.

---

## Recommended workflow (the funnel)

Use this for "find the best X material / what's being said on <topic>" research tasks.

**Golden rule — protect your context window:** threads and timelines are large. NEVER bulk-read them during
exploration. Rank on cheap search metadata first; read a full thread only for the handful that survive.

```
GATE 1 — cast a wide net (CHEAP: search)
  Run several query variants (synonyms / intent angles / operators), dedupe by id.
    xrelay search "prompt engineering" --limit 40 --product Top
    xrelay search "writing prompts for llms" --product Latest --min-faves 50
    xrelay search "context engineering" --since 2026-01-01 --filter -replies
  Each tweet already carries: author (+verified, followers), likes, retweets, replies, quotes,
  bookmarks, views, date, lang, url. Rank on THESE alone.
  Signals: authority (verified / known author / followers), validation (likes + views + bookmarks),
  recency (date — matters for fast topics), specificity (the text), reach (retweets/quotes).
  Keep the ~10–15 most promising. NO thread reads yet.

GATE 2 — enrich the authors (1 CALL each: user)
  xrelay user <handle>        # bio, follower count, verified, how active
  Confirm an author is who you think. Drop weak sources. Optionally peek a source's recent posts:
  xrelay user-posts <handle> --limit 20

GATE 3 — full read (EXPENSIVE: thread — only the few that survive)
  xrelay thread <id|url>      # the tweet + its replies/conversation

Cross-source: your own saved material is a parallel input (a LOCAL cache —
offline, instant, no rate limits) —
  xrelay bookmarks -q "<topic>"   # fuse what you've already saved with live results
  xrelay my-posts -q "<topic>"    # and what you've written
```

`--product Top` ranks by X's own engagement model (best for "the best on <topic>"); `--product Latest`
gives recency (best for "what's being said right now" and incremental sweeps).

---

## Building a large corpus (100+ sources)

When the task is "gather everything on <topic>" rather than "find the best few", don't hand-loop `search`.
Lead with **`archive search`** (full-fidelity capture straight to a file) and **`batch`** (many query variants,
serialized, deduped into one archive), then **`dedupe`** to fold in any extra passes:

```
printf '%s\n' "prompt engineering" "context engineering" "llm evals" > queries.txt
xrelay batch --file queries.txt --out corpus.json --delay 3000 --product Latest
xrelay dedupe corpus.json extra-pass.json --out merged.json --sort engagement
```

`batch --out` merges incrementally, so you can re-run it to top up the same file; `dedupe` gives you an offline
merge/rank across whatever files you've accumulated.

> **Anti-pattern — never fire many parallel `xrelay search` calls from your shell.** Concurrent queries get the
> account rate-limited fast. **Serialize with 2–5s gaps** — `batch --delay` does exactly this for you. On a
> `RATE_LIMITED` error, back off by `error.retryAfterMs` before retrying (see Error codes below).

---

## Commands (atomic reference)

All commands print a JSON envelope to stdout — `{ ok, command, data }` on success,
`{ ok:false, command, error:{code,message,hint} }` on failure. Exit codes: 0 ok, 1 command error,
2 unknown command.

### `search` — COST: cheap, broad. The net.
```
xrelay search "<query>" [--limit N] [--product Top|Latest|Media|People]
       [--from <h>] [--to <h>] [--since YYYY-MM-DD] [--until YYYY-MM-DD]
       [--lang xx] [--min-faves N] [--min-retweets N] [--filter media|links|replies|-replies ...]
       [--sort engagement] [--compact | --fields a,b,c]
```
- X **advanced operators also work inside the query string** — the flags are just a typed shortcut that
  get folded into it. `--filter -replies` excludes replies; `--filter media` keeps only media tweets.
- Returns `{ query, product, tweets: [{ id, url, text, author:{handle,name,verified,followers},
  metrics:{likes,retweets,replies,quotes,bookmarks,views}, createdAt, lang, media[], ... }], nextCursor }`.
- **Output modes** (context-savers for large sweeps):
  - `--sort engagement` — rank results by an engagement score (`likes + replies*3 + bookmarks*2`) before returning.
  - `--compact` — return flat rows `{ id, url, handle, name, date, text (≤280), likes, replies, bookmarks, views }`
    with a `compact: true` marker, instead of the full nested envelope. Much cheaper on context for ranking passes.
  - `--fields a,b,c` — project each row down to just those compact fields (any of the compact keys above).
    Mutually exclusive with `--compact`; an empty or unknown field name errors loudly (`INVALID_INPUT`).
  - Compact/field-projected output drops the nested author + full metrics — use full output when you need those,
    and note `dedupe` wants full output (compact rows lose `author`).
  - **Over MCP** the `search` tool returns **compact rows by DEFAULT** (agents want slim output); pass
    `compact: false` for the full enriched envelope. The CLI defaults to full output — `--compact` opts in.

### `user` — COST: 1 call. Vet a source.
```
xrelay user <handle|url>
```
- Returns `{ id, handle, name, bio, verified, followers, following, tweets, createdAt, location, avatar, url }`.

### `user-posts` — COST: medium. A source's timeline.
```
xrelay user-posts <handle|url> [--replies] [--limit N]
```
- `--replies` includes the user's replies (default: just their posts). Returns `{ tweets[], nextCursor }`.

### `thread` — COST: expensive. The full read.
```
xrelay thread <id|url>
```
- Returns `{ root: <tweet>, replies: [<tweet>...], nextCursor }`. Use on finalists only.

### `bookmarks` / `my-posts` — COST: cheap. Your local cache (offline, instant).
```
xrelay bookmarks [-q "<query>"] [--limit N] [--sort relevance|newest|likes|views|bookmarks]
       [--sync] [--repair] [--live]
xrelay my-posts  [-q "<query>"] [--limit N] [--sort ...] [--handle <you>] [--sync] [--live]
```
- Search YOUR saved posts / own posts in a local cache — no rate limits, instant, semantic-free keyword +
  metadata ranking. Returns `{ source, cached, total, syncedAt, tweets[] }`.
- `--sync` refreshes the cache first (incremental — only new since last sync). `--live` bypasses the cache and
  hits X. If the cache is empty, the result carries a `hint` telling you to `sync` first.

### `bookmarks folders` — COST: 1 call. List or browse bookmark folders.
```
xrelay bookmarks folders               # list your bookmark folders
xrelay bookmarks folders <folder-id>   # tweets in a specific bookmark folder
```
- Without `<folder-id>`: returns `{ folders: [{ id, name, count }] }`.
- With `<folder-id>`: returns the folder's tweet timeline as `{ tweets[], nextCursor }`.

### `sync` — COST: medium. Refresh the local cache (incremental).
```
xrelay sync bookmarks|posts|all [--handle <you>] [--repair] [--max N]
```
- Pulls ONLY tweets newer than the last sync (snowflake-id watermark + newest-first early-break) — never a
  full refetch. `--repair` refetches everything and patches records; `--max N` caps a run (good for a first
  sync). `posts` auto-detects your handle from the session (override/remember with `--handle`). Returns
  `{ source, added, total, watermark }`.

### `whoami` / `status` — COST: 1 call. Check the authenticated session.
```
xrelay whoami
xrelay status   # alias for whoami
```
- Returns the authenticated user's profile `{ id, handle, name, bio, verified, followers, ... }`.
  Use this to confirm your session is valid and see which account is active.

### `doctor` — COST: 2 calls (0 with `--offline`). Diagnose the setup.
```
xrelay doctor [--offline]
```
- **Run this first** whenever `xrelay` prints nothing, errors oddly, or returns empty results — it tells you
  what's actually wrong instead of guessing. Checks: entry/symlink + environment, cookie resolution (source /
  browser — presence only, never values), a live `whoami` and a bounded 1-result test search (both capped by a
  15s timeout), plus static usage guidance. Always returns an Ok envelope with `data.healthy` / `data.checks[]`
  / `data.summary`.
- `--offline` skips the two live (network) checks but still resolves cookies (may touch the macOS Keychain) —
  use it to diagnose install/config problems with no network.

### `likes` — COST: medium. Liked tweets.
```
xrelay likes [<handle>] [--limit N]
```
- Returns liked tweets for `<handle>` (or the authenticated user when omitted).
- **Note:** X made others' likes private in June 2024 — only your own likes are accessible. Passing
  another handle will likely return an empty set. Returns `{ tweets[], nextCursor }`.

### `feed` — COST: medium. Your home timeline.
```
xrelay feed [--following] [--limit N]
```
- Without `--following`: the algorithmic for-you feed. With `--following`: the chronological
  following timeline. Returns `{ tweets[], nextCursor }`.

### `archive` — COST: medium — incremental. Full-fidelity capture.

Shared flags for all archive targets:
```
[--out <file.json>]   output file (required unless --stdout)
[--limit N]           cap the number of tweets fetched this run
[--full]              ignore knownIds, rebuild from scratch up to --limit
[--prune]             replace the file with exactly the current set (removes deleted items)
[--stdout]            print archive JSON to stdout instead of writing to disk
[--since YYYY-MM-DD]  client-side post-filter: keep tweets >= 00:00:00 UTC on that date
```
- `--since` is a client-side post-filter for all targets. For `archive search`, it also folds into the
  server-side query operator. Tweets with an unparseable date are kept (fail-open).

```
xrelay archive bookmarks [--out <file.json>] [--limit N] [--full] [--prune] [--stdout] [--since YYYY-MM-DD]
       xrelay archive bookmarks --folder <folder-id> [--out <file.json>] [--limit N] [--full] [--prune] [--stdout] [--since YYYY-MM-DD]
       xrelay archive user <handle> [--replies] [--out <file.json>] [--limit N] [--full] [--prune] [--stdout] [--since YYYY-MM-DD]
       xrelay archive my-posts [--replies] [--out <file.json>] [--limit N] [--full] [--prune] [--stdout] [--since YYYY-MM-DD]
       xrelay archive search "<query>" [--product Top|Latest|Media|People] [--from <h>] [--since YYYY-MM-DD]
              [--until YYYY-MM-DD] [--lang xx] [--min-faves N] [--min-retweets N] [--filter <v> ...]
              [--out <file.json>] [--limit N] [--stdout]
       xrelay archive list <list-id> [--out <file.json>] [--limit N] [--full] [--prune] [--stdout] [--since YYYY-MM-DD]
       xrelay archive likes [<handle>] [--out <file.json>] [--limit N] [--full] [--prune] [--stdout] [--since YYYY-MM-DD]
       xrelay archive feed [--following] [--out <file.json>] [--limit N] [--stdout] [--since YYYY-MM-DD]
```
- **bookmarks** (default): captures full-fidelity bookmark set (rich media, article markdown, quoted tweets,
  retweet unwrap, ISO timestamps) into `{ schema, source, generatedAt, count, newestId, tweets:[ArchiveTweet] }`.
  Incremental by default (loads existing file, uses its ids to stop early). `--full` ignores knownIds.
  `--prune` replaces the file with exactly the current bookmark set. Pair with `--full` for a clean snapshot.
  `--folder <id>`: archive from a specific bookmark folder.
- **user `<handle>`**: same fidelity, user's timeline. `--replies` includes replies. `--since` post-filters.
- **my-posts**: archives your own posts (self-detected handle). `--replies` includes replies.
- **search `"<query>"`**: archives search results. Accepts all advanced search flags. No membership-stop
  (search order is not id-monotonic); `--since` post-filters client-side and folds into the server query.
- **list `<list-id>`**: archives tweets from a Twitter List.
- **likes `[<handle>]`**: archives liked tweets; defaults to your own (own-likes only since June 2024).
- **feed `[--following]`**: archives your home feed (for-you) or `--following` (chronological). No
  membership-stop (feed ordering is not id-monotonic); `--since` post-filters client-side.
- Returns `{ source, out?, added, total, newestId }`.

### `batch` — COST: N calls, serialized. Many searches → one deduped archive.
```
xrelay batch --file queries.txt (--out merged.json | --stdout)
       [--delay 2000] [--limit N] [--product Top|Latest|Media|People] [--quiet]
```
- One query per line (blank lines and `#` comments skipped). Runs them **strictly serialized** with `--delay`
  ms between queries (default 2000), continue-on-error (a failed query is recorded with `{code, message,
  retryAfterMs?}` and the run proceeds; a `RATE_LIMITED` query waits its `retryAfterMs` before the next),
  deduped by tweet id across all queries. Progress prints to stderr (`searching k/n: <query>`); `--quiet`
  silences it. `--out` **MERGES** into an existing archive at that path (incremental — safe to re-run).
- Returns `{ queries, succeeded, failed, totalUnique, out?, perQuery }`.

### `dedupe` — COST: free, offline. Merge search/archive files.
```
xrelay dedupe <file...> (--out merged.json | --stdout) [--sort engagement]
```
- Offline merge + dedupe (by tweet id) of `xrelay search` envelopes AND `archive`/`batch` files (shape is
  auto-detected). No network. `--sort engagement` ranks the merged set; any other `--sort` errors loudly.
  `--out` writes a **FRESH** archive from exactly the listed inputs (overwrites — it does not merge into an
  existing file the way `batch --out` does). CLI-only (not an MCP tool).
- **Caveat:** expects FULL (non-compact) search output — compact rows have no `author`, so they degrade the
  merged archive. Don't feed `--compact`/`--fields` output into `dedupe`.

### More endpoints

```
xrelay list <list-id> [--limit N]           # tweets from a Twitter List (curated sources)
xrelay user-media <handle> [--limit N]      # a user's images/videos only (visual evidence)
xrelay followers <handle> [--limit N]       # a user's followers   (network mapping)
xrelay following <handle> [--limit N]       # who a user follows
xrelay retweeters <id|url> [--limit N]      # who retweeted a tweet (amplification graph)
xrelay likers <id|url> [--limit N]          # who liked a tweet      (engagement graph)
xrelay quoters <id|url> [--limit N]         # tweets quoting a tweet (reactions; recency-windowed)
xrelay trends [--woeid N] [--limit N]       # what's hot now (woeid 1 = worldwide, default)
xrelay article <id|url>                     # a long-form X Article → Markdown
xrelay media <id|url> [--out <dir>]         # a tweet's image/video URLs; --out downloads the files
xrelay community <community-id> [--limit N] # a community's tweet feed (topical, moderated sub-network)
xrelay community-info <community-id>        # community metadata: name, members, rules, topic, creator
```

- **`retweeters`/`followers`/`following`** return `{ users:[<profile>...], nextCursor }` — the
  amplification/audience graph. Use them to answer "who is paying attention to / amplifying X".
- **`likers`** also returns `{ users }`, but X made likes private in 2024, so it's usually **empty** for
  tweets you don't own (only the like *count* is public — read that from the tweet's `metrics.likes`).
- **`quoters`** is search-based (`quoted_tweet_id:`), so it's recency-windowed, not the full historical set.
- **`trends`** is a cheap zoomed-out entry point before drilling into `search`.
- **`article`** returns `{ id, title, markdown, url }` — the full long-form read for a finalist.
- **`media`** returns `{ tweetId, media:[{type,url,...}], files? }`; `--out <dir>` saves the actual
  image/video files (for OCR / transcription / multimodal analysis).
- **`community`** returns the community's feed as a normal `{ tweets[], nextCursor }` — a focused,
  on-topic corpus that's often higher-signal than open search for a niche. **`community-info`** returns
  `{ name, description, memberCount, moderatorCount, rules[], topic, tags[], creator, url }`. Get the
  `community-id` from a community URL (`x.com/i/communities/<id>`). Note: X exposes no stable endpoint for
  a full member roster or within-community search, so those aren't provided — use the feed + `search`.

---

## Write commands (mutate the live account)

These commands make changes to your X account. They require a valid authenticated session (same cookie
as read commands). Non-destructive writes (like / bookmark / retweet) are immediately reversible.
Destructive writes (delete) require `--confirm`.

All write commands return `{ ok, command, data }` on success; the `data` shape varies by command.

### Posting
```
xrelay post "<text>" [-i <path>] ...           # post a new tweet. Returns { id, url }
xrelay reply <id|url> "<text>" [-i <path>] ... # reply to a tweet. Returns { id, url }
xrelay quote <id|url> "<text>" [-i <path>] ... # quote-tweet. Returns { id, url }
```
- `-i`/`--image` attaches a local image file (JPEG, PNG, GIF, WebP). Repeat up to 4 times.
  Each image is uploaded via the chunked media upload API before the tweet is created.

### Engagement toggles (reversible)
```
xrelay like <id|url>              # like a tweet.    data: { tweetId, action:"liked" }
xrelay unlike <id|url>            # undo a like.     data: { tweetId, action:"unliked" }
xrelay bookmark <id|url>          # bookmark a tweet. data: { tweetId, action:"bookmarked" }
xrelay unbookmark <id|url>        # remove a bookmark. data: { tweetId, action:"unbookmarked" }
xrelay retweet <id|url>           # retweet.         data: { tweetId, action:"retweeted" }
xrelay unretweet <id|url>         # undo a retweet.  data: { tweetId, action:"unretweeted" }
```
- `bookmark` saves a tweet to your bookmarks (the write operation). To *search* saved bookmarks, use
  `xrelay bookmarks` (plural, the read/cache command).

### Social graph
```
xrelay follow <handle>            # follow a user.   data: { handle, action:"followed" }
xrelay unfollow <handle>          # unfollow a user. data: { handle, action:"unfollowed" }
```

### Destructive (requires --confirm)
```
xrelay delete <id|url> --confirm  # permanently delete one of your tweets.
                                  # data: { tweetId, action:"deleted" }
```
- Without `--confirm`, returns a `CONFIRMATION_REQUIRED` error and performs NO network call.
  This is a safety guard — a destructive action never fires by accident.

---

## Composition notes

- **Dedupe by `id`** across multiple `search` calls — that's your job, not the tool's.
- **Rank, don't read.** The whole point is to avoid reading threads you don't need. Engagement + recency +
  authority on the search results is usually enough to pick the 2–3 worth a `thread` read.
- **Operators are powerful**: `from:` (one author), `min_faves:` (quality floor), `since:`/`until:` (a window),
  `filter:media`/`-filter:replies` (shape). Combine them to make the net precise instead of huge.

## Error codes

On failure the `error` object is `{ code, message, hint }` plus two **optional** fields when X supplies them:
`status` (the upstream HTTP status) and `retryAfterMs` (how long to wait before retrying — set on
`RATE_LIMITED`). Read `retryAfterMs` and back off by it rather than guessing.

- `INVALID_INPUT` — empty query / missing handle or id, or an unparseable tweet id/URL, or a bad flag combo
  (`--compact` + `--fields`, an empty/unknown `--fields` name, an unsupported `--sort`). No network call.
- `AUTH_FAILED` — session cookies expired/invalid. Re-log into x.com in your browser (or set XRELAY_COOKIES).
- `RATE_LIMITED` — X throttled the token; wait `error.retryAfterMs` (when present) before retrying, and
  serialize queries with 2–5s gaps. `batch` handles this pacing for you.
- `FEATURE_DRIFT` — X rotated its private API; the tool's query-ids/features need a refresh.
- `NOT_FOUND` — the tweet/user is unavailable, or a transient API hiccup.
- `CONFIRMATION_REQUIRED` — destructive write attempted without `--confirm`. Re-run with `--confirm` to proceed.
- `UNKNOWN_COMMAND` — unrecognized command.

## Setup

```
npm i -g x-relay-mcp
```
Cookies are read automatically from your logged-in browser (macOS Keychain). The first run may show a one-time
Keychain "Always Allow" prompt. Assumes a residential IP (run locally); datacenter IPs are blocked by X.

### Troubleshooting

- **If `xrelay` prints nothing, exits silently, or errors oddly → run `xrelay doctor` first.** It reports what's
  actually wrong (install/entry, cookies, auth, a live test search) instead of leaving you to guess. Use
  `xrelay doctor --offline` to diagnose install/config with no network calls.
- The old npm global-install silent-exit is fixed (the binary now fails loudly to stderr), so
  `node $(readlink -f $(which xrelay))` should no longer be needed — but it still works and proves the install
  resolves to a real entry file if you ever suspect a broken symlink.
- Empty results from `thread` / `retweeters` / `likers` / `quoters` / `article` / `media` are no longer silent:
  an unparseable id/URL fails loudly with `INVALID_INPUT` + a hint, so a bad ref won't masquerade as "no data".

### Account pool + proxy (optional — for heavy/sustained use)

X rate-limits per account and blocks datacenter IPs. For deep sweeps, give the tool **several sessions, each
behind its own residential proxy**; it transparently fails over to the next session when one hits a rate-limit
(429) or its cookies expire — so a long research run survives a single account getting throttled. All optional;
the default single-browser-session path needs none of this.

```
# Several accounts, each pinned to its own proxy (JSON array — the robust form):
export XRELAY_ACCOUNTS='[
  {"cookies":"auth_token=..; ct0=..","proxy":"http://user:pass@host1:port","label":"main"},
  {"cookies":"auth_token=..; ct0=..","proxy":"socks5://user:pass@host2:port"}
]'

# Or a simpler newline list of cookie strings, with proxies round-robined onto them:
export XRELAY_ACCOUNTS=$'auth_token=..; ct0=..\nauth_token=..; ct0=..'
export XRELAY_PROXIES='http://host1:port, http://host2:port'

# Single browser session, just routed through one proxy:
export XRELAY_PROXY='http://user:pass@host:port'
```

Rotation triggers on `RATE_LIMITED` / `AUTH_FAILED` only; other errors fail fast. Pair an equal number of
accounts and proxies for a clean 1:1 mapping. http(s) and socks proxies are both supported.
