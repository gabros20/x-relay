// Public library surface. Command runners are added as they land.
export * from './types.ts';
export { ok, err, toJson } from './output.ts';
export { extractTweetId, extractHandle } from './ids.ts';
export {
  createEngine,
  EngineError,
  type Engine,
  type EngineDeps,
  type SearchOpts,
  type UserTweetsOpts,
  type PageOpts,
} from './engine/index.ts';
export {
  createEngineFromEnv,
  createHermesTweetEngine,
  type HermesTweetConfig,
} from './engine/hermes-tweet.ts';
export { parseCookies, type Cookies } from './engine/auth.ts';
export { getCookies, extractCookies } from './engine/cookies.ts';
export {
  COMMANDS,
  commandNames,
  runSearch,
  runUser,
  runUserPosts,
  runThread,
  runBookmarks,
  runMyPosts,
  runSync,
  runList,
  runUserMedia,
  runFollowers,
  runFollowing,
  runRetweeters,
  runLikers,
  runQuoters,
  runTrends,
  runArticle,
  runMedia,
  buildSearchQuery,
} from './commands/index.ts';
export { parseArgs, dispatch, run } from './cli.ts';
export {
  type CacheSource,
  type CacheFile,
  type CacheSort,
  type SyncResult,
  loadCache,
  saveCache,
  searchCache,
  syncBookmarks,
  syncPosts,
} from './cache/index.ts';
