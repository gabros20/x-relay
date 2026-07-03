# Issue #2 Implementation Plan — Agent-Ergonomics & P0 Silent-Exit Fix

**Source:** GitHub issue #2 "Field report: agent research session (July 2026) — symlink silent exit, rate limits, research ergonomics"
**Execution model:** Subagent-driven development. One fresh implementer subagent per task (TDD mandatory: failing test first), then spec-compliance review, then code-quality review. Orchestrator never edits code.
**Branch:** `fix/issue-2-agent-ergonomics` (semantic-release runs from `main`; merge when green).
**Commit style:** Conventional Commits, one logical unit per task (`fix:`→patch, `feat:`→minor, `docs:`/`test:` no release).

## Scope decisions (orchestrator judgment)

**In scope (this plan):** P0 `isEntry` fix + fail-loud; `doctor`; stderr progress + `--quiet`; `--compact`/`--fields`/`--sort engagement`; `batch` + `dedupe`; rate-limit surfacing (`retryAfterMs` in envelope); thread/tweet-id input validation; MCP parity for new + key missing tools (`archive`, `whoami`); SKILL.md + README updates.

**Deferred (documented, not built):** `funnel` command (skill funnel already documents the gates; `batch` + `--sort engagement` covers 90% of it), `batch --resume`, cross-process global queue / `XRELAY_CONCURRENCY` (batch's built-in serialization + delay is the practical fix; a cross-process lockfile queue is high complexity/low ROI), `xrelay export` to bookmark-search schema, full MCP parity for write commands (deliberate: keep MCP read-only), 2.0.0 shared-schema items.

## Cross-cutting facts every implementer must know

- **Repo:** `/Users/tamas/Documents/Personal/Projects/x-relay`. Bun + TS ESM. `bun run check` = typecheck + lint (Biome) + `bun test`. `bun run generate` runs before every test/build (regenerates `src/generated/skill.ts` from `.claude/skills/x-relay/SKILL.md` — one-directional, SKILL.md is source).
- **TDD is mandatory** (CLAUDE.md): write the failing test, watch it fail, minimal code to pass.
- **Envelope** (`src/types.ts:8-16`, `src/output.ts:3-10`): `Ok<T>={ok:true,command,data}`; `Err={ok:false,command,error:{code,message,hint?}}`. `guard()` in `src/commands/runners.ts:36-51` maps `EngineError`→`err(...)`.
- **Adding a CLI flag:** it MUST be added to `VALUE_FLAGS` or `BOOL_FLAGS` in `src/cli.ts:56-137` or it is silently dropped. Repeated value flags accumulate into `string[]`; helpers `first()`, `num()`.
- **Adding a command touches ≥5 places:** flag sets (cli.ts), a dispatch case (`src/cli.ts:383-442` — Biome cognitive-complexity 25 means new commands likely need a new `dispatchXOps` helper), a runner in `runners.ts` wrapped in `guard()`, a `COMMANDS` entry in `src/commands/registry.ts` (commands absent from the registry are rejected by the name guard at `cli.ts:451`), and a manual `server.registerTool` in `src/mcp-shim.ts` (registration is hand-written, NOT registry-driven).
- **Stdout discipline:** the ONLY stdout writers are `cli.ts:447/452/459/473` (help/unknown/envelope/fatal) and `runners.ts:491` (`archive --stdout`). Nothing writes stderr today. Keep stdout JSON-clean; progress goes to stderr.
- **Test conventions:** `bun:test`. `tests/cli.test.ts` uses a full `fakeEngine(calls: string[])` recording call strings, asserts via `dispatch(parseArgs(...), fake)`. `tests/runners.test.ts` uses partial stubs cast `as unknown as Engine`. `tests/client.test.ts` injects `fakeFetch(queue)`, `sleepSpy()`, `transactionSpy()` into `createClient`.
- **Parallel-safety rule:** stage ONLY your own files (`git add <paths>`, never `git add -A`); if `git commit` fails on `index.lock` contention, wait 2s and retry. Never run `lint:fix`/`format` repo-wide — only on files you own.

## Waves & file-ownership matrix

| Wave | Task | Owns (exclusive during wave) |
|------|------|------------------------------|
| 1 (parallel) | T1 entry-fix | `src/cli.ts` + `src/mcp-shim.ts` (entry blocks), new `src/entry.ts`, new `tests/entry.test.ts` |
| 1 (parallel) | T2 rate-limit surfacing | `src/engine/client.ts`, `src/engine/index.ts` (EngineError), `src/types.ts`, `src/output.ts`, `src/commands/runners.ts` (guard only), `tests/client.test.ts`, `tests/runners.test.ts` |
| 1 (parallel) | T3 format helpers | new `src/format.ts`, new `tests/format.test.ts` |
| 1 (parallel) | T4 ids strict extraction | `src/ids.ts`, `tests/ids.test.ts` |
| 2 (serial) | T5 thread/tweet-id validation wiring | `runners.ts`, `cli.ts`, `mcp-shim.ts` |
| 2 (serial) | T6 search output flags wiring | `cli.ts`, `runners.ts`, `registry.ts`, `mcp-shim.ts` |
| 3 (serial) | T7 doctor command | new `src/commands/doctor.ts`, `cli.ts`, `runners.ts`, `registry.ts`, `mcp-shim.ts`, new `tests/doctor.test.ts` |
| 3 (serial) | T8 batch + dedupe + progress/--quiet | new `src/commands/batch.ts`, new `src/progress.ts`, `cli.ts`, `runners.ts`, `registry.ts`, `mcp-shim.ts`, tests |
| 4 (serial) | T9 MCP parity extras | `mcp-shim.ts` |
| 4 (serial) | T10 SKILL.md + README + docs | `.claude/skills/x-relay/SKILL.md`, `README.md` |
| 5 | Final QC | full `bun run check`, whole-branch review, smoke |

Wave 1 tasks have disjoint file sets and run in parallel. Waves 2–4 are serialized because they all touch the cli/registry/mcp-shim hub.

---

## T1 — Fix `isEntry` silent exit + fail-loud (P0)

**Problem.** `src/cli.ts:463-465` (byte-identical copy at `src/mcp-shim.ts:322-324`):
```ts
const isEntry =
  import.meta.main === true ||
  (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]);
```
When invoked via the npm bin symlink (`…/bin/xrelay → …/dist/cli.js`), `process.argv[1]` is the symlink path while `fileURLToPath(import.meta.url)` is the real `dist/cli.js` path — unequal. If `import.meta.main` is not `true` in that Node context (it's Bun-native; Node only from 20.11, and not set in all harnesses), `isEntry` is false → the CLI **silently exits 0 with no output**. Catastrophic for agents.

**Spec.**
1. Create `src/entry.ts` exporting a pure, testable helper, e.g. `isMainModule(argv1: string | undefined, moduleUrl: string, importMetaMain: boolean | undefined): boolean`:
   - `importMetaMain === true` → true; `importMetaMain === false` → false (runtime explicitly told us).
   - Otherwise compare `realpathSync(argv1)` against `realpathSync(fileURLToPath(moduleUrl))` — this resolves the symlink. Wrap realpath in try/catch (nonexistent paths → fall back to plain string compare, then false).
2. Use it in both entry files: `src/cli.ts` and `src/mcp-shim.ts` bottom blocks. **Constraint:** `tsup.config.ts` sets `splitting: false` deliberately so the guard logic is bundled into each entry file — a shared `src/entry.ts` source module is fine (it gets inlined into both bundles), but do not change tsup splitting.
3. Fail-loud: in `cli.ts`, when `argv1` is defined, the module was NOT detected as main, and the resolved `argv1` basename is `xrelay` or `cli.js` (i.e. it *looks* like a CLI invocation that our check failed to recognize), print `xrelay: entry detection failed — treating as main; report at github.com/gabros20/x-relay/issues` to **stderr** and run anyway (never silent exit when the user clearly invoked the binary). Mirror for `x-relay-mcp`/`mcp-shim.js` in mcp-shim.
4. TDD: `tests/entry.test.ts` — unit tests for `isMainModule` covering: importMetaMain true/false short-circuits; equal plain paths; **symlink → realpath equality** (create a real temp symlink with `fs.mkdtempSync` + `fs.symlinkSync` pointing at a temp file, pass symlink as argv1); nonexistent argv1; undefined argv1.
5. Note: tests import `dispatch`/`parseArgs` from `cli.ts` — importing the module must never print the warning (only the looks-like-CLI heuristic path may).

**Acceptance:** unit tests green; `bun run check` green; existing behavior of `run()` untouched.
**Commit:** `fix(cli): robust main-module detection via realpath; never silently exit under npm bin symlink`

## T2 — Surface rate-limit info in the envelope (P1)

**Problem.** `src/engine/client.ts` `classify()` (lines 150-193): on 429 with retries exhausted it returns terminal `{code:'RATE_LIMITED',status:429,...}`; `backoffMs()` (69-75) computes wait from the `x-rate-limit-reset` header (epoch seconds → ms-until-reset, default `DEFAULT_BACKOFF_MS=1000`) but the value is **discarded** on exhaustion. `EngineError` (`src/engine/index.ts:76-85`) carries `code`+`status`; `guard()` (`runners.ts:36-51`) discards `status` and emits only `{code,message,hint}`. Agents can't tell they should back off, or for how long.

**Spec.**
1. `client.ts`: when 429 retries are exhausted, include `retryAfterMs` (the value `backoffMs(res)` would return for the final response) in the terminal error object. Add `retryAfterMs?: number` to the `ClientResult` error shape.
2. `engine/index.ts`: `EngineError` gains optional `retryAfterMs`; the two throw sites that map client errors (~lines 740, 783: `throw new EngineError(lastError.code, lastError.message, lastError.status)`) pass it through.
3. `types.ts`: `Err.error` gains optional `status?: number` and `retryAfterMs?: number`. `output.ts` `err()` gains optional params for them (backward-compatible signature). `guard()` passes `e.status` and `e.retryAfterMs` through, and adds a hint for `RATE_LIMITED`: `"rate limited — wait retryAfterMs before retrying; serialize queries with 2-5s gaps"`.
4. Envelope stays backward compatible — new fields optional, omitted when undefined.
5. TDD: `tests/client.test.ts` — 429×(maxRetries+1) queue with `x-rate-limit-reset` header → terminal error has correct `retryAfterMs`. `tests/runners.test.ts` — stub engine throwing `EngineError('RATE_LIMITED', …, 429, retryAfterMs)` → envelope `error.retryAfterMs`/`error.status` present; a non-rate-limit EngineError → fields absent.

**Acceptance:** tests green; no change to success envelopes; `bun run check` green.
**Commit:** `feat(engine): surface rateLimited status and retryAfterMs in error envelope`

## T3 — Pure output-format helpers (P1)

**Problem.** Agents blow context on full envelopes and rank engagement manually (`likes + replies*3 + bookmarks*2`).

**Spec.** New `src/format.ts`, pure functions only (no I/O), operating on `Tweet` (`src/types.ts:31-38` — `metrics:{likes?,retweets?,replies?,quotes?,bookmarks?,views?}` all optional):
1. `engagementScore(t: Tweet): number` = `likes + replies*3 + bookmarks*2`, missing metrics = 0.
2. `sortByEngagement(tweets: Tweet[]): Tweet[]` — new array, descending score, stable for ties.
3. `compactTweet(t: Tweet)` → flat object: `{id, url, handle, name, date, text, likes, replies, bookmarks, views}` — text truncated to 280 chars with `…` when longer; numeric fields default 0; omit `name` when absent.
4. `projectFields(t: Tweet, fields: string[])` — pick from the compact shape's keys; unknown field names are ignored (but see T6: CLI validates before calling).
5. TDD: `tests/format.test.ts` — score math incl. missing metrics; sort order + stability; truncation boundary (280 exactly vs 281); projection incl. unknown-key ignore.

**Acceptance:** no imports from engine/cache; helpers total <150 lines; `bun run check` green.
**Commit:** `feat(search): add engagement scoring, compact and field-projection helpers`

## T4 — Strict tweet-id extraction in ids.ts (P2)

**Problem.** `extractTweetId` (`src/ids.ts:47-61`) returns `null` for a URL without a `status/` segment; callers fall back to the raw string (`runThread(engine, extractTweetId(target) ?? target)` at `cli.ts:399`, mirrored `mcp-shim.ts:138`) → garbage goes to the engine → empty result instead of an error.

**Spec.** ids.ts only (wiring is T5):
1. Add `looksLikeTweetRef(input: string): boolean` (or equivalently `classifyTweetInput`): true when the input is a URL on any `X_HOSTS` host (i.e. the user *meant* a tweet reference) even if id extraction fails. Bare non-numeric strings → false.
2. Keep `extractTweetId` semantics unchanged (other callers rely on them).
3. TDD in `tests/ids.test.ts`: URL with status → extract works (existing); URL on x.com **without** status → `looksLikeTweetRef` true + extract null; `https://x.com/user/status/` (empty id) → same; non-URL garbage → false; bare snowflake → extract works.

**Acceptance:** existing ids tests untouched and green.
**Commit:** `feat(ids): classify tweet-reference inputs to enable strict validation`

## T5 — Thread/tweet-id input validation wiring (P2, wave 2)

**Spec.**
1. In `runners.ts`, add a small shared helper (e.g. `resolveTweetIdOrErr(command, input)`) used by `runThread` — and by the other tweet-id runners (`retweeters`, `likers`, `quoters`, `article`, `media`) where the CLI currently does `extractTweetId(x) ?? x`: if `extractTweetId` is null, return `err(command,'INVALID_INPUT', "could not extract a tweet id from '<input>'", 'pass a snowflake ID or a URL containing /status/<id>')` instead of calling the engine with garbage.
2. Prefer moving extraction INTO the runners (cli/mcp-shim pass raw input) so validation lives in one place; update `cli.ts` and `mcp-shim.ts` call sites accordingly.
3. TDD: `tests/runners.test.ts` — malformed URL to `runThread` → `INVALID_INPUT` envelope, engine never called (assert via stub). `tests/cli.test.ts` — `dispatch` on `thread https://x.com/foo` → error envelope, exit path unchanged for valid inputs.

**Acceptance:** valid URL/id behavior identical to before; `bun run check` green.
**Commit:** `fix(thread): reject unparseable tweet references with INVALID_INPUT instead of empty results`

## T6 — Wire `--sort engagement`, `--compact`, `--fields` into search (P1, wave 2)

**Spec.**
1. `cli.ts`: add `fields` to `VALUE_FLAGS`, `compact` to `BOOL_FLAGS` (`sort` is already a value flag; the `SORTS` set at `cli.ts:148` is cache-only — do NOT add engagement there; live-search sort is validated separately in `buildSearchOpts`).
2. `runSearch` (`runners.ts:98-110`) opts gain `sort?: 'engagement'`, `compact?: boolean`, `fields?: string[]` (comma-split in CLI). Post-fetch pipeline order: sort → project/compact. `--fields` implies compact-style flat output with just those keys; `--compact` and `--fields` are mutually exclusive → `INVALID_INPUT` if both. Unknown field name → `INVALID_INPUT` listing valid names. Result envelope: `data.tweets` becomes the compact/projected array; add `data.compact: true` marker when transformed.
3. Use T3's helpers from `src/format.ts` — do not reimplement.
4. `registry.ts`: update the `search` usage string with the new flags.
5. `mcp-shim.ts` search tool: add `sort` (enum: `engagement`) and `compact` (boolean, **default true** — issue P3: agents blow context on full envelopes; document the default in the tool description).
6. TDD: `runners.test.ts` — sort order applied; compact shape; fields projection; both-flags error; unknown-field error. `cli.test.ts` — flags parse and reach the runner.

**Acceptance:** default output unchanged when no new flag is passed (CLI); `bun run check` green.
**Commit:** `feat(search): --sort engagement, --compact and --fields output modes`

## T7 — `xrelay doctor` (P0, wave 3)

**Spec.** New `src/commands/doctor.ts` with `runDoctor(engine, opts, deps?)` where `deps` allows test injection (cookie resolver, env, platform, argv). Checks (each `{name, ok, detail}`; never throws — failures are reported):
1. **entry**: node version, `process.argv[1]`, its realpath, whether it's a symlink — flags the pre-fix silent-exit environment.
2. **cookies**: resolution source (`XRELAY_COOKIES` env vs browser extract via `getCookies()`/`extractCookies()` in `src/engine/cookies.ts:154-185`), which browser/profile, `auth_token`+`ct0` presence (never print cookie values).
3. **auth (live)**: `engine.whoami()` → handle; a `RATE_LIMITED` error is reported with `retryAfterMs` (from T2).
4. **search (live)**: 1-result test search, reports latency.
5. **guidance**: static detail — serialize queries with 2–5s gaps, residential IP assumption, pool env vars (`XRELAY_ACCOUNTS`/`XRELAY_PROXIES`).
`--offline` bool flag skips 3–4. Envelope: `{ok: allOk, command:'doctor', data:{checks, summary}}`.
Wire: registry entry (`cost: '2 calls'`), flag set (offline), dispatch (new `dispatchDiagOps` helper if complexity requires), MCP `registerTool('doctor', …)`.
TDD: `tests/doctor.test.ts` with stub engine + injected deps — all-green path, cookie-missing path, whoami-throws path, offline skips network.

**Acceptance:** `bun run check` green; doctor never exits nonzero due to a *check* failing to run (envelope `ok:false` is fine).
**Commit:** `feat(doctor): environment, cookie, auth and search diagnostics command`

## T8 — `xrelay batch` + `xrelay dedupe` + stderr progress + `--quiet` (P0/P1, wave 3)

**Spec.**
1. New `src/progress.ts`: `progressReporter(quiet: boolean)` returning `(msg: string) => void` that writes `msg + '\n'` to **stderr** (never stdout) unless quiet. `--quiet` added to `BOOL_FLAGS`, threaded to batch (and available for future long ops).
2. New `src/commands/batch.ts`, `runBatch(engine, opts)`:
   - `xrelay batch --file queries.txt [--delay 2000] [--limit 30] [--product Top] [--out merged.json] [--stdout]` — one query per line (skip blanks/`#` comments), **strictly serialized** with `delay` ms between calls (default 2000).
   - Per-query progress on stderr: `searching 3/10: <query>`.
   - Continue-on-error: a failed query records `{query, error:{code, retryAfterMs?}}` and the loop continues (a RATE_LIMITED failure waits `retryAfterMs ?? delay` before the next query).
   - Dedupe by tweet id across all queries; merge/save reusing `mergeArchive`/`saveArchive`/`toArchiveTweet` from `src/archive.ts` when `--out` given (archive-file format, provenance lists the queries); `--stdout` prints the merged result envelope instead.
   - Summary envelope on stdout: `{queries, succeeded, failed, totalUnique, out?, perQuery:[{query, count, error?}]}`.
   - Inject a `sleep` dep for tests (pattern: `client.test.ts` sleepSpy).
3. `runDedupe(opts)` (offline, no engine): `xrelay dedupe <file...> --out merged.json [--sort engagement]` — accepts files produced by `xrelay search` (envelope with `data.tweets`) or `xrelay archive` (ArchiveFile; detect by shape), merges, dedupes by id, optional engagement sort (T3 helper), writes archive-format `--out` or `--stdout`. Summary envelope: `{files, totalIn, totalUnique, out?}`.
4. Wire both: flag sets (`file`, `delay` value flags), registry entries, dispatch, MCP tool for `batch` only (dedupe is local-file tooling; note the omission in the tool description or skip silently).
5. TDD: `tests/batch.test.ts` — serialization order + sleepSpy called with delay; dedupe across queries; continue-on-error incl. rate-limited wait; progress messages captured via injected reporter; dedupe file-shape detection + merge counts (use temp dirs).

**Acceptance:** stdout carries ONLY the final JSON envelope; progress on stderr; `bun run check` green.
**Commit:** `feat(batch): serialized multi-query batch with dedupe, stderr progress and --quiet`

## T9 — MCP parity extras (wave 4)

**Spec.** In `mcp-shim.ts`, register missing read tools the issue calls out: `archive` (target, query/handle, out, limit, full, since — mirroring `runArchive` args; note MCP agents usually want `--stdout` semantics: return the summary, require `out` path) and `whoami` (no args). Do NOT add write commands (keep MCP read-only — deliberate). Follow the existing `wrap()` pattern (`mcp-shim.ts:44-50`). Confirm `doctor`/`batch`/search-compact from T6–T8 are registered; fix if missed.
TDD: extend whatever MCP-shim test coverage exists; if none exists for tool registration, add a light test that imports the tool-registration listing if feasible without starting the server — otherwise verify via `bun run build` + a scripted stdio handshake in a test-skipped smoke script and say so in the report.
**Commit:** `feat(mcp): expose archive and whoami tools; document read-only parity policy`

## T10 — SKILL.md + README + docs (P3, wave 4, last)

**Spec.**
1. `.claude/skills/x-relay/SKILL.md` (source of truth; `bun run generate` re-embeds it):
   - **Troubleshooting** section: "if `xrelay` prints nothing → run `xrelay doctor`; invoke via `node $(readlink -f $(which xrelay))` as fallback" (post-fix this should not happen; keep the recipe).
   - Lead corpus-building guidance with `archive search` and the new `batch` (100+ sources workflows).
   - **Anti-pattern** callout: never run many parallel `xrelay` searches from agent shells; serialize with 2–5s gaps (that's what `batch --delay` does).
   - Document `doctor`, `batch`, `dedupe`, `--compact`/`--fields`/`--sort engagement`, and the `error.retryAfterMs` envelope field.
2. `README.md`: same highlights briefly (new commands + flags, doctor-first troubleshooting).
3. Run `bun run generate` and commit the regenerated `src/generated/skill.ts` with it.
4. Keep registry usage strings and SKILL.md consistent (registry entries were updated in T6–T8; verify).
**Commit:** `docs(skill): doctor-first troubleshooting, batch/dedupe workflows, compact output modes`

## Final QC (orchestrator-driven)

1. `bun run check` on the branch — all green.
2. `bun run build`; create a temp **symlink** to `dist/cli.js`; `node <symlink> --help` and `node <symlink> search --help` must print (P0 regression proof). Also invoke `dist/cli.js` directly.
3. Whole-branch code review subagent (diff vs `main`): correctness, envelope backward-compat, stdout purity, no scope creep.
4. Report: task-by-task summary, commits, deferred items, suggested release flow (merge → semantic-release cuts 1.5.0).
