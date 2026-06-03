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

/** Fetches x.com, following the migration redirect + form, and returns the homepage Document. */
export async function handleXMigration(fetchImpl: typeof fetch = fetch): Promise<XDocument> {
  const response = await fetchImpl('https://x.com', { headers: BROWSER_HEADERS });
  if (!response.ok) {
    throw new XHomePageFetchError(response.status, response.statusText);
  }

  const htmlText = await response.text();
  let document = parseHTML(htmlText).window.document as unknown as XDocument;

  const migrationRedirectionRegex =
    /(http(?:s)?:\/\/(?:www\.)?(twitter|x){1}\.com(\/x)?\/migrate([/?])?tok=[a-zA-Z0-9%\-_]+)+/i;

  const metaRefresh = document.querySelector("meta[http-equiv='refresh']");
  const metaContent = metaRefresh ? metaRefresh.getAttribute('content') || '' : '';
  const migrationRedirectionUrl =
    migrationRedirectionRegex.exec(metaContent) || migrationRedirectionRegex.exec(htmlText);

  if (migrationRedirectionUrl) {
    const redirectResponse = await fetchImpl(migrationRedirectionUrl[0]);
    if (!redirectResponse.ok) {
      throw new XMigrationRedirectionError(redirectResponse.status, redirectResponse.statusText);
    }
    document = parseHTML(await redirectResponse.text()).window.document as unknown as XDocument;
  }

  const migrationForm =
    document.querySelector("form[name='f']") ||
    document.querySelector("form[action='https://x.com/x/migrate']");

  if (migrationForm) {
    const url = migrationForm.getAttribute('action') || 'https://x.com/x/migrate';
    const method = migrationForm.getAttribute('method') || 'POST';
    const requestPayload = new FormData();
    for (const element of Array.from(migrationForm.querySelectorAll('input'))) {
      const name = element.getAttribute('name');
      const value = element.getAttribute('value');
      if (name && value) requestPayload.append(name, value);
    }
    const formResponse = await fetchImpl(url, { method, body: requestPayload });
    if (!formResponse.ok) {
      throw new XMigrationFormError(formResponse.status, formResponse.statusText);
    }
    document = parseHTML(await formResponse.text()).window.document as unknown as XDocument;
  }

  return document;
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
