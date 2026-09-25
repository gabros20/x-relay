// Helpers for the x-client-transaction-id generator. Vendored + ported from
// Lqm1/x-client-transaction-id (MIT). `handleXMigration` is the network boundary
// that produces the homepage Document the generator initializes from.
import { parseHTML } from 'linkedom';
import type { XDocument } from './dom.ts';
import { XHomePageFetchError, XMigrationFormError, XMigrationRedirectionError } from './errors.ts';

const BROWSER_HEADERS: Record<string, string> = {
  accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'accept-language': 'en-US,en;q=0.9',
  'cache-control': 'no-cache',
  pragma: 'no-cache',
  priority: 'u=0, i',
  'sec-ch-ua': '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
};

/** Marker for the responsive-web `ondemand.s` webpack chunk the txid generator needs. */
export const ON_DEMAND_MARKER = 'ondemand.s';

/**
 * X paths whose logged-out HTML may still ship the legacy `responsive-web` runtime
 * (the site-verification key + `loading-x-anim` frames + the `ondemand.s` webpack
 * manifest) that the x-client-transaction-id generator initializes from. Tried in
 * order; the first one that carries the runtime wins.
 *
 * Why not the root `/`: X migrated `https://x.com` (and profile pages) to a new
 * "x-web" frontend whose logged-out shell no longer inlines that runtime, so a
 * root fetch now yields a Document the generator can't bootstrap from.
 *
 * 2026-09: X is rolling "x-web" out to these paths too, as a PER-REQUEST split —
 * the same URL returns the legacy shell only some of the time (measured: ~0–50%
 * per path, /i/flow/login ~0%). So one pass over three paths now fails most runs.
 * The list is ordered by measured legacy rate and walked for several rounds
 * (BOOTSTRAP_ROUNDS); every candidate is a logged-out-renderable page.
 */
const BOOTSTRAP_PATHS = [
  // 2026-09-25: the root now serves the x-web shell, which dropped `ondemand.s`
  // but still carries the verification key and the loading-x-anim frames; the
  // indices moved into a lazy `sign.o` chunk (see resolveSignChunkUrl). Tried
  // first because it is the one path that reliably answers 200 with a shell.
  '/',
  '/i/bookmarks',
  '/settings',
  '/notifications',
  '/home',
  '/explore',
  '/i/flow/signup',
  '/i/flow/login',
] as const;

/** Passes over BOOTSTRAP_PATHS before giving up (8 paths × 4 rounds = 32 fetches worst case). */
const BOOTSTRAP_ROUNDS = 4;
/** Jittered pause between rounds, so the retries don't read as a tight scraping loop. */
const BOOTSTRAP_ROUND_DELAY_MS = [400, 1200] as const;

/** The x-web frontend's module entry, which leads to the `sign.o` signer chunk. */
export const X_WEB_ENTRY_REGEX =
  /https:\/\/abs\.twimg\.com\/x-web\/[^"'`\s]*entry-client[^"'`\s]*\.js/;

/**
 * Whether a shell can bootstrap the generator: either the legacy runtime, or an
 * x-web shell carrying all three of the key, the animation frames and the entry
 * that leads to the indices.
 */
export function isUsableShell(html: string): boolean {
  if (html.includes(ON_DEMAND_MARKER)) return true;
  return (
    html.includes('twitter-site-verification') &&
    html.includes('loading-x-anim') &&
    X_WEB_ENTRY_REGEX.test(html)
  );
}

export interface HandleXMigrationOptions {
  rounds?: number;
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const MIGRATION_REDIRECTION_REGEX =
  /(http(?:s)?:\/\/(?:www\.)?(twitter|x){1}\.com(\/x)?\/migrate([/?])?tok=[a-zA-Z0-9%\-_]+)+/i;

/** Fetches one X URL, following the migration redirect + form; returns the final Document + its HTML. */
async function fetchShellDocument(
  url: string,
  fetchImpl: typeof fetch,
): Promise<{ document: XDocument; html: string }> {
  const response = await fetchImpl(url, { headers: BROWSER_HEADERS });
  if (!response.ok) {
    throw new XHomePageFetchError(response.status, response.statusText);
  }

  let htmlText = await response.text();
  let document = parseHTML(htmlText).window.document as unknown as XDocument;

  const metaRefresh = document.querySelector("meta[http-equiv='refresh']");
  const metaContent = metaRefresh ? metaRefresh.getAttribute('content') || '' : '';
  const migrationRedirectionUrl =
    MIGRATION_REDIRECTION_REGEX.exec(metaContent) || MIGRATION_REDIRECTION_REGEX.exec(htmlText);

  if (migrationRedirectionUrl) {
    const redirectResponse = await fetchImpl(migrationRedirectionUrl[0]);
    if (!redirectResponse.ok) {
      throw new XMigrationRedirectionError(redirectResponse.status, redirectResponse.statusText);
    }
    htmlText = await redirectResponse.text();
    document = parseHTML(htmlText).window.document as unknown as XDocument;
  }

  const migrationForm =
    document.querySelector("form[name='f']") ||
    document.querySelector("form[action='https://x.com/x/migrate']");

  if (migrationForm) {
    const formUrl = migrationForm.getAttribute('action') || 'https://x.com/x/migrate';
    const method = migrationForm.getAttribute('method') || 'POST';
    const requestPayload = new FormData();
    for (const element of Array.from(migrationForm.querySelectorAll('input'))) {
      const name = element.getAttribute('name');
      const value = element.getAttribute('value');
      if (name && value) requestPayload.append(name, value);
    }
    const formResponse = await fetchImpl(formUrl, { method, body: requestPayload });
    if (!formResponse.ok) {
      throw new XMigrationFormError(formResponse.status, formResponse.statusText);
    }
    htmlText = await formResponse.text();
    document = parseHTML(htmlText).window.document as unknown as XDocument;
  }

  return { document, html: htmlText };
}

/**
 * Fetches an X shell that still carries the responsive-web runtime and returns its
 * Document. Follows the migration redirect + form on each candidate path.
 *
 * Walks BOOTSTRAP_PATHS for up to `rounds` passes (X serves the legacy shell per
 * request, see BOOTSTRAP_PATHS) and returns the first Document whose HTML still
 * contains the `ondemand.s` runtime. If none do (X finished migrating these paths),
 * the last successfully fetched Document is returned so the downstream generator
 * throws the precise OnDemandFileUrlResolutionError rather than a vague transport
 * error. Only if every candidate fetch itself failed do we rethrow.
 */
export async function handleXMigration(
  fetchImpl: typeof fetch = fetch,
  options: HandleXMigrationOptions = {},
): Promise<XDocument> {
  const rounds = Math.max(1, options.rounds ?? BOOTSTRAP_ROUNDS);
  const sleep = options.sleep ?? defaultSleep;
  let lastDocument: XDocument | undefined;
  let lastError: unknown;

  for (let round = 0; round < rounds; round += 1) {
    if (round > 0) {
      const [min, max] = BOOTSTRAP_ROUND_DELAY_MS;
      await sleep(min + Math.floor(Math.random() * (max - min)));
    }
    for (const path of BOOTSTRAP_PATHS) {
      try {
        const { document, html } = await fetchShellDocument(`https://x.com${path}`, fetchImpl);
        lastDocument = document;
        if (isUsableShell(html)) return document;
      } catch (error) {
        lastError = error;
      }
    }
  }

  if (lastDocument) return lastDocument;
  throw lastError ?? new XHomePageFetchError(0, 'no X bootstrap path returned a usable shell');
}

/** Floating-point → hex string (integer part + optional hex fraction). */
export function floatToHex(x: number): string {
  const result: string[] = [];
  let n = x;
  let quotient = Math.floor(n);
  const fraction = n - quotient;

  while (quotient > 0) {
    quotient = Math.floor(n / 16);
    const remainder = Math.floor(n - quotient * 16);
    if (remainder > 9) {
      result.unshift(String.fromCharCode(remainder + 55));
    } else {
      result.unshift(remainder.toString());
    }
    n = quotient;
  }

  if (fraction === 0) return result.join('');

  result.push('.');
  let frac = fraction;
  while (frac > 0) {
    frac *= 16;
    const integer = Math.floor(frac);
    frac -= integer;
    if (integer > 9) {
      result.push(String.fromCharCode(integer + 55));
    } else {
      result.push(integer.toString());
    }
  }
  return result.join('');
}

/** -1.0 for odd numbers, 0.0 for even (used as a cubic control-point seed). */
export function isOdd(num: number): number {
  return num % 2 ? -1.0 : 0.0;
}
