// Single source of truth for command definitions. Drives CLI help/dispatch and
// is available to the skill generator. Keep in sync with the runners below.

export interface CommandDef {
  name: string;
  /** Funnel cost hint shown in help + skill. */
  cost: string;
  summary: string;
  usage: string;
}

export const COMMANDS: CommandDef[] = [
  {
    name: 'search',
    cost: 'cheap — the net',
    summary: 'Live X search. Cast a wide net; rank on engagement/recency metadata.',
    usage:
      'xrelay search "<query>" [--limit N] [--product Top|Latest|Media|People]\n' +
      '       [--from <h>] [--to <h>] [--since YYYY-MM-DD] [--until YYYY-MM-DD]\n' +
      '       [--lang xx] [--min-faves N] [--min-retweets N] [--filter media|links|replies|-replies ...]',
  },
  {
    name: 'user',
    cost: '1 call',
    summary: 'Profile lookup: bio, followers, verified, counts, joined.',
    usage: 'xrelay user <handle|url>',
  },
  {
    name: 'user-posts',
    cost: 'medium',
    summary: "A user's timeline (optionally including replies).",
    usage: 'xrelay user-posts <handle|url> [--replies] [--limit N]',
  },
  {
    name: 'thread',
    cost: 'expensive — full read',
    summary: 'A tweet plus its reply thread. Read only the finalists.',
    usage: 'xrelay thread <id|url>',
  },
  {
    name: 'bookmarks',
    cost: 'cheap — local cache',
    summary: 'Search your saved posts in the local cache. --sync to refresh, --live to hit X.',
    usage:
      'xrelay bookmarks [-q "<query>"] [--limit N] [--sort relevance|newest|likes|views|bookmarks]\n' +
      '       [--sync] [--repair] [--live]\n' +
      '       xrelay bookmarks folders               # list your bookmark folders\n' +
      '       xrelay bookmarks folders <folder-id>   # tweets in a bookmark folder',
  },
  {
    name: 'my-posts',
    cost: 'cheap — local cache',
    summary: 'Search your own posts in the local cache. --sync to refresh, --live to hit X.',
    usage:
      'xrelay my-posts [-q "<query>"] [--limit N] [--sort ...] [--handle <you>] [--sync] [--live]',
  },
  {
    name: 'sync',
    cost: 'medium — incremental',
    summary: 'Pull only NEW bookmarks/posts since the last sync into the local cache.',
    usage: 'xrelay sync bookmarks|posts|all [--handle <you>] [--repair]',
  },
  {
    name: 'list',
    cost: 'medium',
    summary: 'Tweets from a Twitter List (curated sources).',
    usage: 'xrelay list <list-id> [--limit N]',
  },
  {
    name: 'user-media',
    cost: 'medium',
    summary: "A user's media posts only (images/videos) — visual evidence.",
    usage: 'xrelay user-media <handle|url> [--limit N]',
  },
  {
    name: 'followers',
    cost: 'medium',
    summary: "A user's followers (network mapping).",
    usage: 'xrelay followers <handle|url> [--limit N]',
  },
  {
    name: 'following',
    cost: 'medium',
    summary: 'Who a user follows.',
    usage: 'xrelay following <handle|url> [--limit N]',
  },
  {
    name: 'retweeters',
    cost: 'medium',
    summary: 'Who retweeted a tweet (amplification graph).',
    usage: 'xrelay retweeters <id|url> [--limit N]',
  },
  {
    name: 'likers',
    cost: 'medium',
    summary: 'Who liked a tweet (engagement graph).',
    usage: 'xrelay likers <id|url> [--limit N]',
  },
  {
    name: 'quoters',
    cost: 'medium',
    summary: 'Tweets quoting a tweet (reactions/discourse; recency-windowed).',
    usage: 'xrelay quoters <id|url> [--limit N]',
  },
  {
    name: 'trends',
    cost: 'cheap',
    summary: "What's trending now — a zoomed-out entry point.",
    usage: 'xrelay trends [--woeid N] [--limit N]   # woeid 1 = worldwide (default)',
  },
  {
    name: 'article',
    cost: 'medium',
    summary: 'Fetch a long-form X Article and render it to Markdown.',
    usage: 'xrelay article <id|url>',
  },
  {
    name: 'media',
    cost: 'medium',
    summary: "A tweet's image/video assets (URLs); --out <dir> downloads the files.",
    usage: 'xrelay media <id|url> [--out <dir>]',
  },
  {
    name: 'community',
    cost: 'medium',
    summary: "A community's tweet feed (a topical, moderated sub-network).",
    usage: 'xrelay community <community-id> [--limit N]',
  },
  {
    name: 'community-info',
    cost: '1 call',
    summary: 'Community metadata: name, description, member/mod counts, rules, topic, creator.',
    usage: 'xrelay community-info <community-id>',
  },
  {
    name: 'likes',
    cost: 'medium',
    summary:
      "A user's liked tweets (own-likes only since June 2024 — X no longer exposes others' likes).",
    usage: 'xrelay likes [<handle>] [--limit N]',
  },
  {
    name: 'feed',
    cost: 'medium',
    summary: 'Your home timeline (for-you) or --following (chronological).',
    usage: 'xrelay feed [--following] [--limit N]',
  },
  {
    name: 'archive',
    cost: 'medium — incremental',
    summary: 'Full-fidelity capture of bookmarks or a user timeline to a rich JSON archive.',
    usage:
      'xrelay archive bookmarks [--out <file.json>] [--limit N] [--full] [--prune] [--stdout] [--since YYYY-MM-DD]\n' +
      '       xrelay archive bookmarks --folder <folder-id> [--out <file.json>] [--limit N] [--full] [--prune] [--stdout] [--since YYYY-MM-DD]\n' +
      '       xrelay archive user <handle> [--replies] [--out <file.json>] [--limit N] [--full] [--prune] [--stdout] [--since YYYY-MM-DD]\n' +
      '       xrelay archive my-posts [--replies] [--out <file.json>] [--limit N] [--full] [--prune] [--stdout] [--since YYYY-MM-DD]\n' +
      '       xrelay archive search "<query>" [--product Top|Latest|Media|People] [--from <h>] [--since YYYY-MM-DD]\n' +
      '              [--until YYYY-MM-DD] [--lang xx] [--min-faves N] [--min-retweets N] [--filter <v> ...]\n' +
      '              [--out <file.json>] [--limit N] [--stdout]\n' +
      '       xrelay archive list <list-id> [--out <file.json>] [--limit N] [--full] [--prune] [--stdout] [--since YYYY-MM-DD]\n' +
      '       xrelay archive likes [<handle>] [--out <file.json>] [--limit N] [--full] [--prune] [--stdout] [--since YYYY-MM-DD]\n' +
      '       xrelay archive feed [--following] [--out <file.json>] [--limit N] [--stdout] [--since YYYY-MM-DD]\n' +
      '       Note: --since YYYY-MM-DD is a client-side post-filter (keeps tweets >= 00:00:00 UTC on that date).\n' +
      '             For search, --since also folds into the server-side query operator.\n' +
      '             For likes, omitting <handle> archives YOUR likes (own-likes only since June 2024).\n' +
      '             For feed, --following uses the chronological following timeline; default is the algorithmic for-you feed.\n' +
      '             For bookmarks --folder, archives tweets from a specific bookmark folder.',
  },
  {
    name: 'whoami',
    cost: '1 call',
    summary: 'The authenticated user (handle + profile).  Alias: status.',
    usage: 'xrelay whoami',
  },
  {
    name: 'post',
    cost: '1 call — write',
    summary: 'Post a new tweet. Returns the created tweet id and URL.',
    usage: 'xrelay post "<text>" [-i <path>] [-i <path>] ...   # up to 4 images via --image/-i',
  },
  {
    name: 'reply',
    cost: '1 call — write',
    summary: 'Reply to an existing tweet. Returns the created reply id and URL.',
    usage: 'xrelay reply <id|url> "<text>" [-i <path>] ...   # up to 4 images via --image/-i',
  },
  {
    name: 'quote',
    cost: '1 call — write',
    summary: 'Quote-tweet an existing tweet. Returns the created quote id and URL.',
    usage: 'xrelay quote <id|url> "<text>" [-i <path>] ...   # up to 4 images via --image/-i',
  },
  {
    name: 'like',
    cost: '1 call — write',
    summary: 'Like a tweet. Reversible — unlike to undo.',
    usage: 'xrelay like <id|url>',
  },
  {
    name: 'unlike',
    cost: '1 call — write',
    summary: 'Unlike a previously liked tweet.',
    usage: 'xrelay unlike <id|url>',
  },
  {
    name: 'bookmark',
    cost: '1 call — write',
    summary:
      'Bookmark a tweet (save it). To search saved bookmarks use `xrelay bookmarks` (plural).',
    usage: 'xrelay bookmark <id|url>',
  },
  {
    name: 'unbookmark',
    cost: '1 call — write',
    summary: 'Remove a bookmark.',
    usage: 'xrelay unbookmark <id|url>',
  },
  {
    name: 'retweet',
    cost: '1 call — write',
    summary: 'Retweet a tweet. Reversible — unretweet to undo.',
    usage: 'xrelay retweet <id|url>',
  },
  {
    name: 'unretweet',
    cost: '1 call — write',
    summary: 'Undo a retweet.',
    usage: 'xrelay unretweet <id|url>',
  },
  {
    name: 'delete',
    cost: '1 call — write',
    summary: 'Permanently delete one of your tweets. Requires --confirm (destructive).',
    usage: 'xrelay delete <id|url> --confirm',
  },
  {
    name: 'follow',
    cost: '1 call — write',
    summary: 'Follow a user. Reversible — unfollow to undo.',
    usage: 'xrelay follow <handle>',
  },
  {
    name: 'unfollow',
    cost: '1 call — write',
    summary: 'Unfollow a user.',
    usage: 'xrelay unfollow <handle>',
  },
];

export const commandNames: string[] = COMMANDS.map((c) => c.name);
