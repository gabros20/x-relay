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

Cross-source: your own saved material is a parallel input —
  xrelay bookmarks --limit 50    # fuse what you've already saved with live results
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

### `bookmarks` — COST: medium. Your saved posts.
```
xrelay bookmarks [--limit N]
```
- Returns `{ tweets[], nextCursor }` of your saved posts. (A local, incrementally-synced cache lands later.)

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
