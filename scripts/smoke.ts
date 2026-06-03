// Live smoke test — validates the engine against the real X API.
// Reads cookies from XRELAY_COOKIES so they never touch the repo or argv.
//
// Usage (run from your own shell; cookies stay local):
//   XRELAY_COOKIES='auth_token=<...>; ct0=<...>' bun run scripts/smoke.ts "search query"
//   XRELAY_COOKIES='auth_token=<...>; ct0=<...>' bun run scripts/smoke.ts --user elonmusk
//   XRELAY_COOKIES='auth_token=<...>; ct0=<...>' bun run scripts/smoke.ts --thread <tweet-id>
//   XRELAY_COOKIES='auth_token=<...>; ct0=<...>' bun run scripts/smoke.ts --bookmarks
//
// Export auth_token + ct0 from a logged-in x.com browser session (DevTools →
// Application → Cookies → https://x.com). This is read-only; never commit them.
import { EngineError, createEngine } from '../src/engine/index.ts';
import { parseCookies } from '../src/engine/auth.ts';

async function main(): Promise<void> {
  const raw = process.env.XRELAY_COOKIES;
  if (!raw) {
    console.error('Set XRELAY_COOKIES (e.g. "auth_token=...; ct0=...") and retry.');
    process.exit(2);
  }

  const engine = createEngine({ cookies: parseCookies(raw) });
  const args = process.argv.slice(2);
  const flag = args[0];

  try {
    if (flag === '--user') {
      const handle = args[1] ?? 'elonmusk';
      console.error(`[smoke] user @${handle} ...`);
      console.log(JSON.stringify(await engine.user(handle), null, 2));
    } else if (flag === '--thread') {
      const id = args[1];
      if (!id) throw new Error('--thread needs a tweet id');
      console.error(`[smoke] thread ${id} ...`);
      const t = await engine.thread(id);
      console.log(JSON.stringify({ root: t.root, replies: t.replies.length }, null, 2));
    } else if (flag === '--bookmarks') {
      console.error('[smoke] bookmarks (first 10) ...');
      const page = await engine.bookmarks({ limit: 10 });
      console.log(JSON.stringify({ count: page.tweets.length, tweets: page.tweets }, null, 2));
    } else {
      const query = args.join(' ') || 'agentic engineering';
      console.error(`[smoke] search "${query}" (first 10) ...`);
      const res = await engine.search(query, { limit: 10 });
      console.log(
        JSON.stringify(
          {
            count: res.tweets.length,
            tweets: res.tweets.map((t) => ({
              id: t.id,
              author: `@${t.author.handle}`,
              likes: t.metrics.likes,
              views: t.metrics.views,
              text: t.text.slice(0, 100),
            })),
          },
          null,
          2,
        ),
      );
    }
    console.error('[smoke] OK');
  } catch (e) {
    if (e instanceof EngineError) {
      console.error(`[smoke] EngineError ${e.code}${e.status ? ` (${e.status})` : ''}: ${e.message}`);
      if (e.code === 'FEATURE_DRIFT') {
        console.error('[smoke] -> the features/query-ids in src/engine/ops.ts are stale; refresh them.');
      }
    } else {
      console.error('[smoke] failed:', e);
    }
    process.exit(1);
  }
}

void main();
