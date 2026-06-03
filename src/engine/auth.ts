// Cookie parsing + the HTTP header builder for authenticated requests to X's
// private GraphQL API. No I/O. See docs/ENGINE-RESEARCH.md §1.

/** The two load-bearing cookies, plus any others the jar carries. */
export type Cookies = { authToken: string; ct0: string; extra?: Record<string, string> };

// The hardcoded public web bearer token (docs/ENGINE-RESEARCH.md §1).
export const BEARER_TOKEN =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

// A realistic Chrome user-agent for a desktop session.
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function parseJsonForm(input: string): Record<string, string> | null {
  try {
    const parsed: unknown = JSON.parse(input);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      out[key] = String(value);
    }
    return out;
  } catch {
    return null;
  }
}

function parsePairForm(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of input.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key.length > 0) out[key] = value;
  }
  return out;
}

/**
 * Parse a browser cookie string (`auth_token=abc; ct0=def; ...`) or a JSON object
 * string (`{"auth_token":"abc","ct0":"def"}`). Throws naming what's missing.
 */
export function parseCookies(input: string): Cookies {
  const jar = parseJsonForm(input.trim()) ?? parsePairForm(input);

  const authToken = jar.auth_token;
  const ct0 = jar.ct0;
  if (authToken === undefined) throw new Error('Missing cookie: auth_token');
  if (ct0 === undefined) throw new Error('Missing cookie: ct0');

  const extra: Record<string, string> = {};
  for (const [key, value] of Object.entries(jar)) {
    if (key !== 'auth_token' && key !== 'ct0') extra[key] = value;
  }

  const cookies: Cookies = { authToken, ct0 };
  if (Object.keys(extra).length > 0) cookies.extra = extra;
  return cookies;
}

/** Serialize to `auth_token=..; ct0=..[; k=v...]` — load-bearing cookies first. */
export function cookieString(cookies: Cookies): string {
  const parts = [`auth_token=${cookies.authToken}`, `ct0=${cookies.ct0}`];
  for (const [key, value] of Object.entries(cookies.extra ?? {})) {
    parts.push(`${key}=${value}`);
  }
  return parts.join('; ');
}

/** The full GraphQL request header set (docs/ENGINE-RESEARCH.md §1). */
export function buildHeaders(args: {
  cookies: Cookies;
  transactionId: string;
  clientLanguage?: string;
}): Record<string, string> {
  const { cookies, transactionId, clientLanguage = 'en' } = args;
  return {
    authorization: `Bearer ${BEARER_TOKEN}`,
    'x-csrf-token': cookies.ct0,
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-active-user': 'yes',
    'x-twitter-client-language': clientLanguage,
    'content-type': 'application/json',
    cookie: cookieString(cookies),
    'x-client-transaction-id': transactionId,
    referer: 'https://x.com/',
    origin: 'https://x.com',
    'sec-fetch-site': 'same-site',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    'user-agent': USER_AGENT,
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9',
  };
}
