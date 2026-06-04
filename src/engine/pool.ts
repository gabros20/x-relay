// Account pool + proxy support. Pure config shaping over env strings (parsing,
// proxy assignment) plus a proxy-bound fetch factory. The engine consumes these
// to run several authenticated sessions behind their own egress IPs and rotate
// between them when X rate-limits or rejects one (see engine/index.ts).
//
// Why: X rate-limits per auth-token and blocks datacenter IPs. Pairing 2-3
// accounts each with a residential proxy, and failing over on 429/auth errors,
// is twscrape's headline reliability pattern — replicated here without the
// paid API. No network here; makeFetch only LAZILY loads undici when a proxy
// is actually set, so the no-proxy path keeps zero overhead and zero deps.

import { type Cookies, parseCookies } from './auth.ts';

/** One authenticated session: its cookies, an optional egress proxy, a label for diagnostics. */
export interface SessionSpec {
  cookies: Cookies;
  proxy?: string;
  label: string;
}

/** Split a proxy env value (comma- and/or newline-separated) into clean URLs. */
export function parseProxyList(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

interface AccountItem {
  cookies?: unknown;
  proxy?: unknown;
  label?: unknown;
}

/** Build a spec from one JSON-array item (object form or bare cookie string). */
function specFromJsonItem(item: unknown, index: number): SessionSpec {
  const cookieStr = typeof item === 'string' ? item : String((item as AccountItem)?.cookies ?? '');
  const spec: SessionSpec = {
    cookies: parseCookies(cookieStr),
    label:
      typeof item === 'object' && item !== null && typeof (item as AccountItem).label === 'string'
        ? String((item as AccountItem).label)
        : `acct${index + 1}`,
  };
  const proxy = typeof item === 'object' && item !== null ? (item as AccountItem).proxy : undefined;
  if (typeof proxy === 'string' && proxy.length > 0) spec.proxy = proxy;
  return spec;
}

/**
 * Parse XRELAY_ACCOUNTS into session specs. Two accepted forms:
 *  - a JSON array: `[{"cookies":"auth_token=..;ct0=..","proxy":"http://..","label":".."}, "auth_token=..;ct0=.."]`
 *  - a newline-separated list of cookie strings (proxies then come from XRELAY_PROXIES).
 * Throws (via parseCookies) when a cookie string is missing auth_token / ct0.
 */
export function parseAccounts(raw: string): SessionSpec[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];

  if (trimmed.startsWith('[')) {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error('XRELAY_ACCOUNTS JSON must be an array');
    return parsed.map(specFromJsonItem);
  }

  return trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, i) => ({ cookies: parseCookies(line), label: `acct${i + 1}` }));
}

/** Round-robin assign proxies onto specs that don't already pin one. Pinned proxies win. */
export function assignProxies(specs: SessionSpec[], proxies: string[]): SessionSpec[] {
  if (proxies.length === 0) return specs;
  return specs.map((spec, i) => {
    if (spec.proxy !== undefined) return spec;
    const proxy = proxies[i % proxies.length];
    return proxy === undefined ? spec : { ...spec, proxy };
  });
}

/**
 * A fetch bound to an egress `proxy` (else the base fetch, returned as-is).
 * undici's ProxyAgent is imported lazily on first proxied call, so consumers
 * without a proxy never pay for it and the dependency stays optional at runtime.
 */
export function makeFetch(proxy: string | undefined, base: typeof fetch): typeof fetch {
  if (proxy === undefined || proxy.length === 0) return base;

  let dispatcher: Promise<unknown> | undefined;
  const getDispatcher = (): Promise<unknown> => {
    if (dispatcher === undefined) {
      dispatcher = import('undici').then((m) => new m.ProxyAgent(proxy));
    }
    return dispatcher;
  };

  const proxied = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const d = await getDispatcher();
    // `dispatcher` is undici's per-request egress hook; not in the standard
    // RequestInit type, so we widen the init object here.
    const widened = { ...(init ?? {}), dispatcher: d } as Parameters<typeof fetch>[1];
    return base(input, widened);
  };
  return proxied as unknown as typeof fetch;
}
