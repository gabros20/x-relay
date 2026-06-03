// Pure extraction of a tweet id or a user handle from bare input or any
// common X/Twitter URL form. No I/O.

// Bare ids must look like a real snowflake (avoid matching stray short numbers);
// an id pulled from an explicit `status/` segment can be any numeric run.
const BARE_TWEET_ID_RE = /^\d{6,20}$/;
const PATH_TWEET_ID_RE = /^\d{1,20}$/;
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

const X_HOSTS = new Set([
  'x.com',
  'www.x.com',
  'twitter.com',
  'www.twitter.com',
  'mobile.twitter.com',
  'mobile.x.com',
]);

// Path segments that are routes, not usernames.
const RESERVED = new Set([
  'i',
  'home',
  'search',
  'explore',
  'notifications',
  'messages',
  'settings',
  'compose',
  'hashtag',
  'status',
  'intent',
  'share',
  'login',
  'signup',
  'about',
]);

function parseUrl(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

/** The canonical numeric tweet id from a bare id or any status URL, else null. */
export function extractTweetId(input: string): string | null {
  if (!input) return null;
  if (BARE_TWEET_ID_RE.test(input)) return input;

  const url = parseUrl(input);
  if (!url || !X_HOSTS.has(url.hostname)) return null;

  // Find the segment immediately after `status` (covers /user/status/<id> and
  // /i/web/status/<id>).
  const segments = url.pathname.split('/').filter(Boolean);
  const statusIdx = segments.indexOf('status');
  if (statusIdx === -1) return null;
  const id = segments[statusIdx + 1];
  return id !== undefined && PATH_TWEET_ID_RE.test(id) ? id : null;
}

/** A bare handle (no @) from @handle, a bare handle, or any profile/status URL. */
export function extractHandle(input: string): string | null {
  if (!input) return null;

  const bare = input.startsWith('@') ? input.slice(1) : input;
  if (HANDLE_RE.test(bare)) return bare;

  const url = parseUrl(input);
  if (!url || !X_HOSTS.has(url.hostname)) return null;

  const first = url.pathname.split('/').filter(Boolean)[0];
  if (first === undefined || RESERVED.has(first.toLowerCase())) return null;
  return HANDLE_RE.test(first) ? first : null;
}
