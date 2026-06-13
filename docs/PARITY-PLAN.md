# Full twitter-cli parity — implementation plan

Goal: bring xrelay to **full capability parity** with twitter-cli — read commands,
archive targets (bookmarks + all user data), AND write operations — on branch
`feat/archive-bookmarks`. Built via subagent-driven-development (implementer → spec
review → quality review per task). Sequencing: quick wins → new-op reads → writes.

Reference (source of truth): twitter-cli at
`/Users/tamas/.local/share/uv/tools/twitter-cli/lib/python3.11/site-packages/twitter_cli/`
(cli.py = commands, client.py = fetchers + write ops, parser.py, serialization.py,
graphql.py = queryIds incl. write ops in FALLBACK_QUERY_IDS).

Conventions: Bun + TS, biome (single quotes, semicolons, `.ts` imports), tests in
`tests/` via `bun:test`, gate `bun run check`, build `tsup`, skill regen `bun run generate`.
Reuse the existing archive pipeline: `engine.archiveBookmarks` (src/engine/index.ts),
`toArchiveTweet`/`mergeArchive` (src/archive.ts), `parseTimeline(v,{rich:true})`,
`ArchiveTweet`/`ArchiveFile` (src/types.ts), rich pacing + membership-stop already in place.

---

## T0 — Multi-target archive plumbing (foundation)

Generalize archive beyond bookmarks so every timeline source can be archived with the
same rich serializer + incremental machinery.
- `src/types.ts`: widen `ArchiveFile.source` to a union: `'bookmarks' | 'user' | 'my-posts' | 'list' | 'search' | 'likes' | 'feed'`. Add optional `query?: string` (for search) and `handle?: string` / `listId?: string` provenance fields to `ArchiveFile`.
- `src/engine/index.ts`: extract the rich-archive pagination core from `archiveBookmarks` into a private helper `archiveTimeline(fetchPage, opts)` that does rich parse + membership-stop + `--full` pacing + `toArchiveTweet` mapping. Re-express `archiveBookmarks` on top of it. (No behavior change for bookmarks — existing tests stay green.)
- `src/commands/runners.ts`: refactor `runArchive` to dispatch on `target` and call the right engine archive method; keep the bookmarks path identical. Stop hard-rejecting non-bookmark targets (they'll be added in later tasks; until then unknown target → INVALID_INPUT).
- Tests: existing archive tests green; add a test that `ArchiveFile.source` union compiles and bookmarks still works.

## T1 — `archive user <handle>` (+ `--replies`) and `archive my-posts`

twitter-cli `user-posts <h> -o` and own-posts. Engine `userTweets` already exists.
- Engine: `archiveUserPosts(handle, {limit, knownIds, full, replies})` using `archiveTimeline` over `userTweets` rich. `archiveMyPosts(...)` resolves self handle via `me()` then delegates.
- Command/dispatch: `archive user <handle> [--replies] [--out --limit --full --prune]`; `archive my-posts [...]`.
- Tests: fake-client fixtures → rich ArchiveTweet[], source 'user'/'my-posts', handle recorded.

## T2 — `archive search "<query>"` and `archive list <id>`

twitter-cli `search -o`, `list` timeline. Engine `search` + `list` already exist.
- Engine: `archiveSearch(query, {limit, full, product})`, `archiveList(listId, {limit, knownIds, full})` via `archiveTimeline`.
- Command: `archive search "<q>" [--product Top|Latest] [advanced flags via buildSearchQuery] [--out ...]`; `archive list <id> [--out ...]`. Note: search is not incremental-by-id (results reorder) — default to `--full`-style full page to `--limit`.
- Tests: fixtures for both; search records `query`, list records `listId`.

## T3 — `--since YYYY-MM-DD` archive filter + `whoami`/`status` command

- `--since`: in `runArchive`, after fetch, drop tweets whose `createdAt` is older than the cutoff (parse via `src/time.ts`; add a `parseTwitterDateMs` helper if needed). Applies to all targets. Flag in cli dispatch.
- `whoami`/`status`: new read command returning the authed user (reuse `engine.me()`; optionally fetch the full profile via `engine.user(handle)`). Registry + runner + dispatch + skill regen. Envelope `{ handle, ...profile }`.
- Tests: `--since` filters correctly (boundary inclusive/exclusive documented); whoami returns handle from injected me().

## T4 — `likes` capability (read command + archive target)

twitter-cli `likes <handle> -o`; queryId `Likes` = `dv5-II7_Bup_PHish7p6fw`. NOTE: X only exposes the authenticated user's OWN likes since June 2024 — surface a hint when archiving another handle.
- `src/engine/ops.ts`: add `Likes` op + `likesRequest({ userId, count, cursor })` (mirror userTweetsRequest variables; fieldToggle withArticlePlainText:false).
- `src/engine/index.ts`: `likes(handle, opts)` (research, slim) + `archiveLikes(handle, {limit, knownIds, full})` (rich via archiveTimeline). Resolve userId via getUser.
- Commands: `likes <handle> [-q --limit --sort]`-style research command (mirror existing read commands) AND `archive likes [<handle>] [--out ...]` (defaults to self).
- Registry + dispatch + skill regen. Tests with fake client.

## T5 — `feed` capability (home + following timeline; read + archive)

twitter-cli `feed -t for-you|following -o`; queryIds `HomeTimeline` = `HCosKfLNW1AcOo3la3mMgg`, `HomeLatestTimeline` = `U0cdisy7QFIoTfu3-Okw0A`.
- `ops.ts`: add both ops + `homeTimelineRequest({ cursor, latest })` (variables per twitter-cli: count, includePromotedContent, latestControlAvailable, requestContext, withCommunity; pick op by `latest`).
- `index.ts`: `feed({ following, limit })` (research) + `archiveFeed({ following, limit, full })`.
- Commands: `feed [--type for-you|following] [--limit]` and `archive feed [--type ...] [--out ...]`.
- Registry + dispatch + skill regen. Tests with fake client (both ops).

## T6 — bookmark `folders` (list + per-folder; read + archive)

twitter-cli `bookmarks folders` (list) and `bookmarks folders <id>` (timeline); queryIds
`BookmarkFoldersSlice` = `i78YDd0Tza-dV4SYs58kRg`, `BookmarkFolderTimeline` = `hNY7X2xE2N7HVF6Qb_mu6w`.
- `ops.ts`: add both ops + builders.
- `index.ts`: `bookmarkFolders()` → `{id,name}[]` (parse slice items) and `folderTimeline(folderId, opts)` rich; `archiveBookmarkFolder(folderId, opts)`.
- Commands: `bookmarks folders [<id>]` (list or timeline) and `archive bookmarks --folder <id> [--out ...]`.
- Registry + dispatch + skill regen. Tests: folder-list parse + folder-timeline fixture.

## T7 — Write foundation (POST GraphQL + CSRF + guards)

twitter-cli write ops POST to `https://x.com/i/api/graphql/{queryId}/{Op}` with a JSON body
`{ variables, features, queryId }`, the `x-csrf-token: ct0` header, and a write delay.
- `src/engine/ops.ts`: add write op entries (CreateTweet, DeleteTweet, FavoriteTweet, UnfavoriteTweet, CreateRetweet, DeleteRetweet, CreateBookmark, DeleteBookmark) + a `postRequest` body builder per op.
- `src/engine/client.ts`: add a `post(op, body)` method (POST, ct0 header from cookies, transaction id, error mapping incl. already-done/duplicate). 
- `src/engine/index.ts`: a generic `mutate(op, variables)` on the engine, plus a small write-delay (injectable sleep). Friendships (follow/unfollow) use the v1.1 REST endpoints (`/1.1/friendships/create.json`/`destroy.json`) like twitter-cli — include a REST POST helper.
- Confirmation/guard: write runners require an explicit flag or arg; destructive ones (delete) require a confirm token. (Execution-time confirmation is the CLI user's responsibility; the command must not auto-fire without the id.)
- Tests: fake client asserts POST shape (op, body, ct0) + error mapping; no live calls.

## T8 — post / reply / quote (CreateTweet)

- `index.ts`: `post(text, {replyToId?, quoteTweetId?, mediaIds?})` via CreateTweet variables (tweet_text, reply{in_reply_to_tweet_id}, attachment_url for quote). Return the created tweet id/url.
- Commands: `post "<text>"`, `reply <id> "<text>"`, `quote <id> "<text>"`. Registry + dispatch + skill regen.
- Tests: assert CreateTweet variables for each mode via fake client.

## T9 — like/unlike + bookmark/unbookmark (toggles)

- `index.ts`: `like(id)`/`unlike(id)` (FavoriteTweet/UnfavoriteTweet), `bookmark(id)`/`unbookmark(id)` (CreateBookmark/DeleteBookmark).
- Commands: `like <id>`, `unlike <id>`, `bookmark <id>`, `unbookmark <id>`. Registry + dispatch + skill regen.
- Tests: assert each op + idempotency/error mapping (already-liked etc.).

## T10 — retweet/unretweet + delete + follow/unfollow

- `index.ts`: `retweet(id)`/`unretweet(id)` (CreateRetweet/DeleteRetweet), `deleteTweet(id)` (DeleteTweet), `follow(handle)`/`unfollow(handle)` (v1.1 friendships create/destroy; resolve userId via getUser).
- Commands: `retweet <id>`, `unretweet <id>`, `delete <id>`, `follow <handle>`, `unfollow <handle>`. `delete` requires explicit confirm arg/flag. Registry + dispatch + skill regen.
- Tests: assert ops; delete guard; follow resolves handle→id.

## T11 — Finalize

- `bun run generate` (skill + SKILL.md reflect all new commands), `bun run check` (full green), `bun run build`, `node dist/cli.js --help` lists every new command.
- Update README/SKILL notes: xrelay is now read + archive + write.
- Final whole-branch code review.

---

## Out of scope / notes
- `show <N>` (view cached tweet by index) is a twitter-cli TUI-session convenience; xrelay's
  stateless JSON-envelope model makes it N/A (the cache is queried via `bookmarks`/`my-posts`).
- Write ops mutate the user's live account; commands must require explicit ids/flags and never
  auto-fire. `delete` requires confirmation. The CLI human runs them deliberately.
