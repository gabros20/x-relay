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
export { parseCookies, type Cookies } from './engine/auth.ts';
export {
  fetchSyndicationTweet,
  syndicationToken,
  type SyndicationResult,
  type SyndicationTweet,
  type SyndicationMedia,
  type SyndicationOpts,
} from './engine/syndication.ts';
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
  runDoctor,
  runArchiveRepair,
  type RepairOpts,
  type RepairResult,
  type DoctorOpts,
  type DoctorReport,
  type DoctorCheck,
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
