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
    cost: 'medium',
    summary: 'Your saved posts (live). A local cached index lands in a later phase.',
    usage: 'xrelay bookmarks [--limit N]',
  },
];

export const commandNames: string[] = COMMANDS.map((c) => c.name);
