# Engine research — X/Twitter internal API (grounded)

Captured 2026-06 from source-walks of **d60/twikit** (Python ref), **the-convocation/twitter-scraper**
(TS, closest to our target), **Lqm1/x-client-transaction-id** + **iSarabjitDhiman/XClientTransaction**
(transaction-id algo), and **vladkens/twscrape** (search + account-pool + resilience). Every query-id hash
and `features` blob below is **version-pinned to early/mid-2026 and WILL rotate** — they are externalized in
config and refreshed from a live browser capture, never hardcoded in logic.

The goal: a from-scratch **TypeScript** engine that talks to X's private GraphQL API with the user's login
cookies — **no paid X API**. We learn from the above; we don't reinvent the GraphQL surface blind.

---

## 1. Auth (cookie-based, the only v1 path)

User supplies `auth_token` + `ct0` (exported from a logged-in browser, or `XRELAY_COOKIES` env / cookie file /
browser auto-extract later). These two cookies are the only load-bearing ones. The password `login()`
onboarding flow (Castle.io device tokens + remote JS `ui_metrics` instrumentation + TOTP subtask machine) is
the most fragile, frequently-399-blocked part — **deferred; cookie injection is primary** (both convocation and
twscrape recommend this).

**Header builder** (`installTo`), sent on every GraphQL call. Endpoints target **`x.com` / `api.x.com`**, not twitter.com:

```
authorization: Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA
x-csrf-token:  <ct0 cookie value, echoed verbatim>     # X enforces double-submit: header == cookie
x-twitter-auth-type: OAuth2Session                     # fixed string for an authed session
x-twitter-active-user: yes
x-twitter-client-language: en
content-type: application/json
cookie: auth_token=<...>; ct0=<...>; <jar carries guest_id/kdt/etc>
user-agent: <a real Chrome UA>
referer: https://x.com/        origin: https://x.com         # load-bearing for Cloudflare
sec-fetch-site: same-site      sec-fetch-mode: cors          sec-fetch-dest: empty
sec-ch-ua / sec-ch-ua-mobile:?0 / sec-ch-ua-platform / accept-language: en-US,en;q=0.9 / priority: u=1, i
x-client-transaction-id: <per-(method,path), see §3>
```

Notes: dedupe the duplicate `ct0` Set-Cookie X returns (keep last). Never delete `ct0` even when X sends
`Max-Age=0` (it tries to clear it; that breaks auth). `isLoggedIn` requires BOTH `ct0` and `auth_token`.

**Guest token** (`POST https://api.x.com/1.1/guest/activate.json`, `x-guest-token` header) is effectively dead
for search/timelines in 2026 — do not build on it.

---

## 2. GraphQL surface (externalized config — `src/engine/ops.ts`)

URL shape: `https://x.com/i/api/graphql/{queryId}/{OperationName}`. Reads = GET with `variables` / `features` /
`fieldToggles` JSON-stringified into query params (use a stable stringify for deterministic order). Mutations =
POST `{variables, features, queryId}` (not in v1 scope — read-only tool).

Operation → queryId snapshots (twscrape mid-2026 + convocation; **verify before first run**):

| Op | queryId (twscrape) | queryId (convocation) |
|---|---|---|
| SearchTimeline | `Yw6L66Pw54NHKuq4Dp7b4Q` | `ML-n2SfAxx5S_9QMqNejbg` |
| UserByScreenName | `IGgvgiOx4QZndDHuD3x9TQ` | `AWbeRIdkLtqTRN7yL_H8yw` |
| UserByRestId | `VQfQ9wwYdk6j_u2O4vt64Q` | — |
| UserTweets | `36rb3Xj3iJ64Q-9wKDjCcQ` | `N2tFDY-MlrLxXJ9F_ZxJGA` |
| UserTweetsAndReplies | `D5eKzDa5ZoJuC1TCeAXbWA` | `2NDLUdBmT_IB5uGwZ3tHRg` |
| UserMedia | `9EovraBTXJYGSEQXZqlLmQ` | — |
| Likes | — | `Pcw-j9lrSeDMmkgnIejJiQ` |
| Bookmarks | `XD0ViOeSOW4YoeNTGjVaYw` | — |
| TweetDetail | `oCon7R-cgWRFy6EfZjaKfg` | `YCNdW_ZytXfV9YR3cJK9kw` |
| Followers / Following | `_orfRBQae57vylFPH0Huhg` / `F42cDX8PDFxkbjjq6JrM2w` | `P7m4Qr-rJEB8KUluOenU6A` / `T5wihsMTYHncY7BB4YxHSg` |
| ListLatestTweetsTimeline | `7UuJsFvnWuZo0HmxrzU42Q` | `Uv3buKIUElzL3Iuc0L0O5g` |

That two maintained tools disagree on the hashes is the whole point: **they rotate; keep them in config and add
a refresher** (twscrape ships `scripts/update_gql_ops.py`; we want an equivalent that scrapes the web bundle).

### SearchTimeline (the headline)
```
variables = { rawQuery: <query>, count: 20, querySource: "typed_query",
              product: "Top"|"Latest"|"Media"|"People", cursor?: <bottom cursor> }
fieldToggles = { withArticleRichContentState: false }   // search/list only
```
- **Advanced operators: no builder, raw passthrough.** `rawQuery` IS the X search-box string. All operators work
  because it's literally that query: `from: to: since:YYYY-MM-DD until:YYYY-MM-DD lang: filter:media
  -filter:replies -filter:retweets min_faves: min_retweets: url: list: geocode:lat,lon,Rkm "exact" OR -exclude
  #tag @mention`. We accept a raw query AND offer a typed helper that *concatenates* flags into it.
- **`product`**: Top (relevance) | Latest (newest-first, best for incremental) | Media | People(→user search).
- **`kv`/`ft` override ergonomics** (twscrape's best idea): every request builder takes optional `kv` (extra/override
  variables) and `ft` (override feature flags). Replicate.

### Bookmarks
```
variables = { count: 20, includePromotedContent: true, cursor? }
features  = FEATURES + { graphql_timeline_v2_bookmark_timeline: true }
```

### UserTweets / -AndReplies / Media / Likes
```
variables = { userId, count: 40, includePromotedContent:false, withQuickPromoteEligibilityTweetFields:true,
              withVoice:true, withV2Timeline:true, cursor? }
fieldToggles = { withArticlePlainText:false }
```

### UserByScreenName
```
variables = { screen_name, withGrokTranslatedBio:false }
fieldToggles = { withPayments:false, withAuxiliaryUserLabels:true }   // separate USER_FEATURES set
```

### `features` blob
X rejects requests with **missing/unknown** feature keys (`(336) The following features cannot be null`) →
treat as a **loud, actionable failure** ("feature drift — refresh ops config"), not a silent error. Keep the
full ~37-key blob in config. Current snapshot is in twscrape's `GQL_FEATURES` and convocation's search request
(see git history of this doc / the source repos). Don't hand-curate keys — scrape the bundle to refresh.

---

## 3. x-client-transaction-id (mandatory anti-bot header)

**Vendor** `Lqm1/x-client-transaction-id` (maintained TS, 1:1 port of `iSarabjitDhiman/XClientTransaction`).
Copy `transaction.ts cubic.ts interpolate.ts rotation.ts utils.ts errors.ts` into `src/engine/xctid/`, swap
`@std/encoding`→`node:crypto`/`Buffer`, parse HTML/SVG with `linkedom`, and **own the two brittle regexes**.

**One-time init** (cache per process, refresh every ~30–60 min and on first 403/404):
1. `GET https://x.com` (browser headers), follow `/migrate?tok=` redirect + form POST → working home HTML.
2. Read `<meta name="twitter-site-verification">` → `keyBytes = base64decode(content)`.
3. Scrape webpack hash → fetch `https://abs.twimg.com/responsive-web/client-web/ondemand.s.{hash}a.js`.
4. From ondemand.s, `INDICES_REGEX = /\(\w\[(\d{1,2})\],\s*16\)/g` → first match = `rowIndex`, rest =
   `keyByteIndices`.
5. Compute `animationKey` from `<div id="loading-x-anim-{keyBytes[5]%4}">` SVG `<path d>`: split on `C`, parse
   number grid, pick `arr[rowIndex]`, run cubic-bezier (`Cubic.getValue`) + `interpolate` + rotation→matrix,
   hex-encode color+matrix bytes, strip `.`/`-`.

**Per-request** (cheap, stateless given cached key/animationKey):
```
EPOCH = 1682924400
timeNow = floor((Date.now() - EPOCH*1000)/1000);  timeBytes = LE 4 bytes
data = `${method}!${path}!${timeNow}${"obfiowerehiring"}${animationKey}`
hash = SHA256(data)            // first 16 bytes only
rnd  = randInt(0..255)
arr  = [...keyBytes, ...timeBytes, ...hash[0..16], 3 /*ADDITIONAL_RANDOM_NUMBER*/]
id   = base64([rnd, ...arr.map(b => b ^ rnd)]).replace(/=/g,"")
```
Durable constants: `DEFAULT_KEYWORD="obfiowerehiring"`, `ADDITIONAL_RANDOM_NUMBER=3`, `EPOCH=1682924400`
(stable since 2023). Volatile: ondemand hash, the scraped indices, animation frames, site-verification key —
all refresh together. On GraphQL 404/226, regenerate a fresh txid and retry (X 404s stale txids; twscrape
retries 3×).

---

## 4. Resilience (port twscrape's policy)

Read-only single-account v1, but build the resilience layer for multi-account later. Per request driver:
- Read `x-rate-limit-remaining` / `x-rate-limit-reset` (unix epoch) on every response. On `remaining==0`,
  back off until `reset` (or rotate account). Track limits **per-(account, operation)** — Search exhaustion
  shouldn't block UserTweets.
- Error→action map: `(88) remaining>0` / `(326)` / `(32)` / bare `403` → session dead (mark account inactive);
  `cf-ray` ≥400 HTML → abort query; `(131)` no-data → abort; `(336)` → loud feature-drift error; `404` →
  regen txid + retry 3×; timeouts → retry same; else lock 15 min.
- Provisional 15-min lock the instant an account is picked (defensive if a request hangs), replaced by the real
  `reset` time or an unlock on clean finish.

---

## 5. Parsing (dual core/legacy — X serves `legacy:null` since 2026-05)

Two-stage like twscrape: (1) recursively collect every object with a `__typename` into flat
`{tweets:{id}, users:{id}}` maps (handles RT/quote resolution by id-lookup); (2) map each to our normalized
type, reading the **new sub-object locations with legacy fallback**.

Robust traversal: port twikit's `find_dict` deep key-search (hunt for `instructions`/`entries`/`result`
anywhere) rather than hardcoding the full JSON path — survives layout drift.

**Tweet fields** (merged object): `id_str`(from `rest_id`), `created_at`, `full_text` (or
`note_tweet.note_tweet_results.result.text` for long-form), `favorite_count`→likes, `retweet_count`,
`reply_count`, `quote_count`, `bookmark_count`, views = `ext_views.count`||`views.count` (string, **outside**
legacy), `lang`, `entities.{hashtags,urls,user_mentions}`, `extended_entities.media`, `conversation_id_str`,
`*_id_str` for reply/quote/retweet flags. url = `https://x.com/{username}/status/{id}`.

**User fields** — read sub-object first, then legacy: `screen_name`/`name`/`created_at` ← `core`;
`profile_image_url_https` ← `legacy`||`avatar.image_url`; `verified`/`verified_type` ← `legacy`||`verification.*`;
`description` ← `legacy`||`profile_bio.description`; `protected` ← `legacy`||`privacy.protected`;
`followers_count`/`friends_count` from legacy; `rest_id` = id. `is_blue_verified` at result root.

**Pagination / end-detection**: walk `instructions[] → entries[]`; `cursorType:"Bottom"` = next page,
`"Top"` = previous; drop `entryId` starting `cursor-`/`promoted`/`who-to-follow-`/`module-`. Feed bottom cursor
back as `variables.cursor`. **End** = no bottom cursor OR limit reached; tolerate up to **3 consecutive empty
entry pages** (promoted-content gaps) before stopping. Per-response dedupe by `id`; catch per-tweet parse
errors and skip (one bad tweet never kills a page).

---

## 6. Incremental sync (the new bit — twscrape lacks it, we add it)

Tweet IDs are **Snowflake = monotonic by time**, so `id` comparison == chronological. For "only fresh since last
run" on bookmarks / my-posts:
```
newestSeen = loadWatermark(source)              // highest id we've cached
for await (const tw of stream(Latest/newest-first)):
    if (tw.id <= newestSeen) break              // everything older already cached — stop early
    store(tw)
saveWatermark(source, max(ids))
```
- Newest-first timelines (Latest search, UserTweets, Bookmarks) make the early-break safe — no full drain.
- `since:`/`until:` operators give server-side incremental windows for global search (persist last-run date).
- Cache key = snowflake `id`. Mutable metrics (likes/views/bookmark_count) — decide refresh-vs-freeze policy
  for already-cached ids (default: refresh metrics on re-sync of the head, freeze body).
- Cursors are NOT reliable across runs (opaque/short-lived, walk backward) — use the id-watermark, not cursors,
  for cross-run freshness.
- "Patch broken data": re-fetch records whose stored shape is incomplete (null author/text) via
  TweetResultByRestId, keyed by id.

---

## Porting priority

1. `xctid/` — vendor + port the transaction-id module (§3). Hardest; everything depends on it.
2. `auth.ts` header builder (§1) — exact strings; `x-csrf-token == ct0`.
3. `ops.ts` config (§2) — query-ids + features externalized + a refresher script.
4. `client.ts` request driver + resilience (§4) — 429/404/336 handling, per-op limits.
5. `parse.ts` — `find_dict` deep-search + dual core/legacy normalize + cursor/end-detection (§5).
6. `cache/` — snowflake-watermark incremental sync (§6).
