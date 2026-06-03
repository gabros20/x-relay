// Automatic browser-cookie extraction for X — no manual export.
// macOS: reads each Chromium browser's Cookies DB (via the system `sqlite3`)
// and decrypts the values with the AES key from the login Keychain
// ("<Browser> Safe Storage"), mirroring browser-cookie3 / twitter-cli. The
// first browser+profile logged into x.com wins. Falls back to XRELAY_COOKIES.
import { execFileSync } from 'node:child_process';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Cookies, parseCookies } from './auth.ts';

// --- pure crypto ------------------------------------------------------------

/** Chrome/Chromium macOS key derivation: PBKDF2(secret, 'saltysalt', 1003, 16, sha1). */
export function deriveKey(keychainSecret: string): Buffer {
  return pbkdf2Sync(keychainSecret, 'saltysalt', 1003, 16, 'sha1');
}

function isPrintableAscii(s: string): boolean {
  return /^[\x20-\x7e]*$/.test(s);
}

/**
 * Decrypts a Chromium cookie value. `v10`/`v11` values are AES-128-CBC
 * (iv = 16 spaces) over the Keychain-derived key; newer Chrome prepends a
 * 32-byte SHA-256(domain) to the plaintext, which we strip. Unencrypted values
 * pass through.
 */
export function decryptCookieValue(encrypted: Buffer, key: Buffer): string | null {
  if (encrypted.length === 0) return '';
  const prefix = encrypted.subarray(0, 3).toString('latin1');
  if (prefix !== 'v10' && prefix !== 'v11') return encrypted.toString('utf8');

  const iv = Buffer.alloc(16, ' ');
  const decipher = createDecipheriv('aes-128-cbc', key, iv);
  decipher.setAutoPadding(false);
  let out: Buffer;
  try {
    out = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
  } catch {
    return null;
  }

  // Strip PKCS7 padding manually (Chrome's padding isn't always block-standard).
  const pad = out[out.length - 1] ?? 0;
  if (pad > 0 && pad <= 16) out = out.subarray(0, out.length - pad);

  const direct = out.toString('utf8');
  if (isPrintableAscii(direct)) return direct;
  const stripped = out.subarray(32).toString('utf8');
  if (isPrintableAscii(stripped)) return stripped;
  return direct;
}

export interface CookieRow {
  hostKey: string;
  name: string;
  value: string;
}

/** From decrypted X cookie rows, build the Cookies (auth_token + ct0 + all others). */
export function pickAuthCookies(rows: CookieRow[]): Cookies | null {
  let authToken: string | undefined;
  let ct0: string | undefined;
  const extra: Record<string, string> = {};
  for (const row of rows) {
    if (!row.name || !row.value) continue;
    if (row.name === 'auth_token') authToken = row.value;
    else if (row.name === 'ct0') ct0 = row.value;
    else extra[row.name] = row.value;
  }
  if (authToken === undefined || ct0 === undefined) return null;
  const cookies: Cookies = { authToken, ct0 };
  if (Object.keys(extra).length > 0) cookies.extra = extra;
  return cookies;
}

// --- macOS integration ------------------------------------------------------

interface Browser {
  name: string;
  /** Keychain service: "<keychain> Safe Storage". */
  keychain: string;
  /** Dir under ~/Library/Application Support. */
  base: string;
}

const BROWSERS: Browser[] = [
  { name: 'arc', keychain: 'Arc', base: 'Arc/User Data' },
  { name: 'chrome', keychain: 'Chrome', base: 'Google/Chrome' },
  { name: 'brave', keychain: 'Brave', base: 'BraveSoftware/Brave-Browser' },
  { name: 'edge', keychain: 'Microsoft Edge', base: 'Microsoft Edge' },
];

function browserOrder(): Browser[] {
  const pref = (process.env.XRELAY_BROWSER ?? '').trim().toLowerCase();
  if (!pref) return BROWSERS;
  const first = BROWSERS.filter((b) => b.name === pref);
  return first.length ? [...first, ...BROWSERS.filter((b) => b.name !== pref)] : BROWSERS;
}

/** The AES storage secret from the login Keychain (triggers a one-time auth prompt). */
function keychainSecret(browser: Browser): string | null {
  try {
    return execFileSync(
      'security',
      ['find-generic-password', '-w', '-s', `${browser.keychain} Safe Storage`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
  } catch {
    return null;
  }
}

function profileCookieDbs(browser: Browser): string[] {
  const root = join(homedir(), 'Library', 'Application Support', browser.base);
  if (!existsSync(root)) return [];
  const dbs: string[] = [];
  const defaultDb = join(root, 'Default', 'Cookies');
  if (existsSync(defaultDb)) dbs.push(defaultDb);
  for (const entry of readdirSync(root)) {
    if (entry.startsWith('Profile ')) {
      const db = join(root, entry, 'Cookies');
      if (existsSync(db)) dbs.push(db);
    }
  }
  return dbs;
}

/** Read X cookie rows from a Cookies DB via the system sqlite3 (on a temp copy). */
function readCookieRows(dbPath: string): { hostKey: string; name: string; hexValue: string }[] {
  const tmp = join(mkdtempSync(join(tmpdir(), 'xrelay-')), 'Cookies');
  copyFileSync(dbPath, tmp);
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(dbPath + suffix)) copyFileSync(dbPath + suffix, tmp + suffix);
  }
  const sql =
    'SELECT host_key AS hostKey, name, hex(encrypted_value) AS hexValue FROM cookies ' +
    "WHERE host_key LIKE '%x.com' OR host_key LIKE '%twitter.com'";
  try {
    const out = execFileSync('sqlite3', ['-readonly', '-json', tmp, sql], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out) return [];
    return JSON.parse(out) as { hostKey: string; name: string; hexValue: string }[];
  } catch {
    return [];
  }
}

/** Auto-extract X cookies from the local browser. Returns null if none found. */
export function extractCookies(): Cookies | null {
  if (process.platform !== 'darwin') return null;
  for (const browser of browserOrder()) {
    const dbs = profileCookieDbs(browser);
    if (dbs.length === 0) continue;
    const secret = keychainSecret(browser);
    if (!secret) continue;
    const key = deriveKey(secret);
    for (const db of dbs) {
      const rows = readCookieRows(db).map((r) => ({
        hostKey: r.hostKey,
        name: r.name,
        value: decryptCookieValue(Buffer.from(r.hexValue, 'hex'), key) ?? '',
      }));
      const cookies = pickAuthCookies(rows);
      if (cookies) return cookies;
    }
  }
  return null;
}

/** Cookies resolution: XRELAY_COOKIES env → automatic browser extraction. */
export function getCookies(): Cookies {
  const env = process.env.XRELAY_COOKIES;
  if (env) return parseCookies(env);
  const cookies = extractCookies();
  if (cookies) return cookies;
  throw new Error(
    'No X cookies found. Log into x.com in Arc/Chrome/Brave/Edge (macOS), or set ' +
      'XRELAY_COOKIES="auth_token=...; ct0=...". If a Keychain prompt appeared, click "Always Allow".',
  );
}
