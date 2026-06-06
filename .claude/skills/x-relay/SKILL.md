# x-relay

A **deep-research tool for X/Twitter** for AI agents — a CLI (`xrelay`), an MCP server, and this skill.
Cast a wide net with live search, rank candidates cheaply on engagement/recency metadata, and read full
threads only for the finalists. Cookies are **auto-extracted from your local browser** (Arc/Chrome/Brave/Edge
on macOS) — no manual setup. No paid X API.

The tool is **atomic** (search / user / user-posts / thread / bookmarks). YOU compose the strategy. This skill
gives the **recommended funnel** first, then a per-command reference with cost so you can deviate intelligently.

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

## Commands (atomic reference)

All commands print a JSON envelope to stdout — `{ ok, command, data }` on success,
`{ ok:false, command, error:{code,message,hint} }` on failure. Exit codes: 0 ok, 1 command error,
2 unknown command.

### `search` — COST: cheap, broad. The net.
```
xrelay search "<query>" [--limit N] [--product Top|Latest|Media|People]
       [--from <h>] [--to <h>] [--since YYYY-MM-DD] [--until YYYY-MM-DD]
       [--lang xx] [--min-faves N] [--min-retweets N] [--filter media|links|replies|-replies ...]
```
- X **advanced operators also work inside the query string** — the flags are just a typed shortcut that
  get folded into it. `--filter -replies` excludes replies; `--filter media` keeps only media tweets.
- Returns `{ query, product, tweets: [{ id, url, text, author:{handle,name,verified,followers},
  metrics:{likes,retweets,replies,quotes,bookmarks,views}, createdAt, lang, media[], ... }], nextCursor }`.

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

### `sync` — COST: medium. Refresh the local cache (incremental).
```
xrelay sync bookmarks|posts|all [--handle <you>] [--repair] [--max N]
```
- Pulls ONLY tweets newer than the last sync (snowflake-id watermark + newest-first early-break) — never a
  full refetch. `--repair` refetches everything and patches records; `--max N` caps a run (good for a first
  sync). `posts` auto-detects your handle from the session (override/remember with `--handle`). Returns
  `{ source, added, total, watermark }`.

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

## Composition notes

- **Dedupe by `id`** across multiple `search` calls — that's your job, not the tool's.
- **Rank, don't read.** The whole point is to avoid reading threads you don't need. Engagement + recency +
  authority on the search results is usually enough to pick the 2–3 worth a `thread` read.
- **Operators are powerful**: `from:` (one author), `min_faves:` (quality floor), `since:`/`until:` (a window),
  `filter:media`/`-filter:replies` (shape). Combine them to make the net precise instead of huge.

## Error codes

- `INVALID_INPUT` — empty query / missing handle or id. No network call.
- `AUTH_FAILED` — session cookies expired/invalid. Re-log into x.com in your browser (or set XRELAY_COOKIES).
- `RATE_LIMITED` — X throttled the token; back off and retry later.
- `FEATURE_DRIFT` — X rotated its private API; the tool's query-ids/features need a refresh.
- `NOT_FOUND` — the tweet/user is unavailable, or a transient API hiccup.
- `UNKNOWN_COMMAND` — unrecognized command.

## Setup

```
npm i -g x-relay-mcp
```
Cookies are read automatically from your logged-in browser (macOS Keychain). The first run may show a one-time
Keychain "Always Allow" prompt. Assumes a residential IP (run locally); datacenter IPs are blocked by X.

### Optional Hermes Tweet backend

Use this only when the host cannot use local browser cookies but can call Hermes Tweet/Xquik:

```
export XRELAY_BACKEND=hermes-tweet
export HERMES_TWEET_API_KEY="xq_..."
# Optional, defaults to https://xquik.com
export HERMES_TWEET_BASE_URL="https://xquik.com"
```

`XQUIK_API_KEY` and `XQUIK_BASE_URL` work too. This backend covers `search` and
`user`, preserves the same JSON envelope, and leaves unsupported commands on the
normal local backend.

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
