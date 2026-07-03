// `xrelay doctor` — a self-diagnosis command. The tool used to fail silently for
// agents: a cookie problem, a rate limit, and the npm-bin symlink silent-exit all
// looked identical (empty output). doctor probes each layer and reports a
// per-check result, so the failing layer is obvious. GitHub issue #2 (P0).
//
// Design: doctor ALWAYS returns an Ok envelope whose payload carries
// `healthy: boolean` + the per-check results. A failing CHECK is a normal result,
// not an envelope error — so an agent can read `data.checks` uniformly. The Err
// envelope is reserved for doctor itself crashing (which the top-level try/catch
// below makes practically unreachable). No individual check may throw.
import { lstatSync, realpathSync } from 'node:fs';
import type { Cookies } from '../engine/auth.ts';
import { getCookies } from '../engine/cookies.ts';
import { type Engine, EngineError } from '../engine/index.ts';
import { err, ok } from '../output.ts';
import type { Envelope } from '../types.ts';

/** Default per-check deadline for the live (auth/search) checks. */
const DEFAULT_TIMEOUT_MS = 15000;

/** One diagnostic check's outcome. `ok: false` is a normal, expected result. */
export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/** The doctor payload: overall health plus every check and a one-line summary. */
export interface DoctorReport {
  /** True when every non-skipped check passed. */
  healthy: boolean;
  checks: DoctorCheck[];
  summary: string;
}

export interface DoctorOpts {
  /** Skip the two live checks (auth + search) — no network calls. */
  offline?: boolean;
}

/**
 * Injection seams for tests. Everything defaults to the real process/filesystem;
 * tests override to make entry/cookie/latency checks deterministic and to keep
 * the cookie check off the real Keychain.
 */
export interface DoctorDeps {
  /** Resolve cookies (defaults to getCookies — env → browser extract → throw). */
  resolveCookies?: () => Cookies;
  /** Environment map (defaults to process.env). */
  env?: Record<string, string | undefined>;
  /** Platform (defaults to process.platform). */
  platform?: NodeJS.Platform;
  /** The invoked script path (defaults to process.argv[1]). */
  argv1?: string;
  /** Node version string (defaults to process.version). */
  nodeVersion?: string;
  /** Monotonic clock for latency, in ms (defaults to Date.now). */
  now?: () => number;
  /** Per-check deadline for the live checks, in ms (defaults to DEFAULT_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Resolve a path through symlinks (defaults to realpathSync). */
  realpath?: (p: string) => string;
  /** Whether a path is a symlink (defaults to lstatSync().isSymbolicLink()). */
  isSymlink?: (p: string) => boolean;
}

/**
 * entry: node version + how we were invoked. Flags the classic npm-bin symlink
 * (…/bin/xrelay → …/dist/cli.js) that once caused a silent exit 0. Informational —
 * a symlink is normal, so this check is always ok:true; it never throws.
 */
function checkEntry(deps: DoctorDeps): DoctorCheck {
  const nodeVersion = deps.nodeVersion ?? process.version;
  const argv1 = deps.argv1 ?? process.argv[1];
  if (argv1 === undefined) {
    return { name: 'entry', ok: true, detail: `node ${nodeVersion}; argv[1] unknown` };
  }
  const realpath = deps.realpath ?? realpathSync;
  const isSymlink =
    deps.isSymlink ??
    ((p: string) => {
      try {
        return lstatSync(p).isSymbolicLink();
      } catch {
        return false;
      }
    });

  let resolved = argv1;
  try {
    resolved = realpath(argv1);
  } catch {
    // realpath failed (missing/permission) — fall back to the raw argv path.
  }
  let symlink = false;
  try {
    symlink = isSymlink(argv1);
  } catch {
    // lstat failed — treat as not a symlink.
  }
  const note = symlink
    ? ` (symlink → ${resolved})`
    : resolved !== argv1
      ? ` (resolves → ${resolved})`
      : '';
  return { name: 'entry', ok: true, detail: `node ${nodeVersion}; entry ${argv1}${note}` };
}

/**
 * cookies: where auth comes from and whether both required cookies resolve.
 * NEVER prints cookie values — booleans + lengths only. When resolution throws
 * (no cookies), the check fails and the thrown setup hint is surfaced verbatim.
 */
function checkCookies(deps: DoctorDeps): DoctorCheck {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const resolveCookies = deps.resolveCookies ?? getCookies;

  const fromEnv = Boolean(env.XRELAY_COOKIES);
  const source = fromEnv ? 'XRELAY_COOKIES env' : 'browser extract';
  const sourceNote = fromEnv
    ? ''
    : platform !== 'darwin'
      ? ' (browser extract is macOS-only)'
      : env.XRELAY_BROWSER
        ? ` (browser: ${env.XRELAY_BROWSER})`
        : '';

  try {
    const cookies = resolveCookies();
    const hasAuth = typeof cookies.authToken === 'string' && cookies.authToken.length > 0;
    const hasCt0 = typeof cookies.ct0 === 'string' && cookies.ct0.length > 0;
    const authNote = hasAuth ? `present (len ${cookies.authToken.length})` : 'MISSING';
    const ct0Note = hasCt0 ? `present (len ${cookies.ct0.length})` : 'MISSING';
    return {
      name: 'cookies',
      ok: hasAuth && hasCt0,
      detail: `source=${source}${sourceNote}; auth_token ${authNote}; ct0 ${ct0Note}`,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { name: 'cookies', ok: false, detail: `source=${source}${sourceNote}; ${message}` };
  }
}

/** Format an EngineError into a detail line, appending status/retryAfterMs when present. */
function engineErrorDetail(e: EngineError): string {
  const parts = [`${e.code}: ${e.message}`];
  if (e.status !== undefined) parts.push(`status ${e.status}`);
  if (e.retryAfterMs !== undefined) parts.push(`retryAfterMs ${e.retryAfterMs}`);
  return parts.join('; ');
}

/** auth: a live whoami() call. RATE_LIMITED (and any error) becomes a failed check, never a throw. */
async function checkAuth(engine: Engine): Promise<DoctorCheck> {
  try {
    const profile = await engine.whoami();
    if (!profile) {
      return { name: 'auth', ok: false, detail: 'whoami returned no profile — not logged in?' };
    }
    return { name: 'auth', ok: true, detail: `authenticated as @${profile.handle}` };
  } catch (e) {
    if (e instanceof EngineError) return { name: 'auth', ok: false, detail: engineErrorDetail(e) };
    return { name: 'auth', ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/** search: a 1-result live search, reporting round-trip latency. Any error becomes a failed check. */
async function checkSearch(engine: Engine, deps: DoctorDeps): Promise<DoctorCheck> {
  const now = deps.now ?? Date.now;
  const start = now();
  try {
    const result = await engine.search('the', { limit: 1 });
    const ms = now() - start;
    return {
      name: 'search',
      ok: true,
      detail: `ok — ${result.tweets.length} result(s) in ${ms}ms`,
    };
  } catch (e) {
    const ms = now() - start;
    const base =
      e instanceof EngineError ? engineErrorDetail(e) : e instanceof Error ? e.message : String(e);
    return { name: 'search', ok: false, detail: `${base} (after ${ms}ms)` };
  }
}

/** guidance: static operational advice. Always ok:true. */
function checkGuidance(): DoctorCheck {
  return {
    name: 'guidance',
    ok: true,
    detail:
      'Serialize queries with 2–5s gaps. Assumes a residential IP — datacenter/cloud IPs get blocked. ' +
      'For heavy use set XRELAY_ACCOUNTS + XRELAY_PROXIES to rotate an account pool.',
  };
}

/** A skipped live check under --offline — ok:true so it never drags down health. */
function skipped(name: string): DoctorCheck {
  return { name, ok: true, detail: 'skipped (--offline)' };
}

/**
 * Bound a live check with a deadline. The Engine API takes no AbortSignal, so a
 * hung request would otherwise hang doctor forever — instead we race the check
 * against a timer and, on a stall, resolve to a failed check. The underlying
 * request may keep running; that's fine for a diagnostics CLI that exits right
 * after. The check itself never rejects (both live checks catch internally), so
 * the race only ever resolves.
 */
function withTimeout(
  work: Promise<DoctorCheck>,
  name: string,
  timeoutMs: number,
): Promise<DoctorCheck> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<DoctorCheck>((resolve) => {
    timer = setTimeout(
      () => resolve({ name, ok: false, detail: `timed out after ${timeoutMs}ms` }),
      timeoutMs,
    );
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Run every diagnostic check and assemble the report. Always resolves to an Ok
 * envelope (a failing check lives in the payload); the try/catch only guards the
 * unreachable case of doctor itself crashing.
 */
export async function runDoctor(
  engine: Engine,
  opts: DoctorOpts = {},
  deps: DoctorDeps = {},
): Promise<Envelope<DoctorReport>> {
  try {
    const offline = opts.offline === true;
    const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const checks: DoctorCheck[] = [
      checkEntry(deps),
      checkCookies(deps),
      offline ? skipped('auth') : await withTimeout(checkAuth(engine), 'auth', timeoutMs),
      offline
        ? skipped('search')
        : await withTimeout(checkSearch(engine, deps), 'search', timeoutMs),
      checkGuidance(),
    ];

    const failed = checks.filter((c) => !c.ok).map((c) => c.name);
    const healthy = failed.length === 0;
    const summary = healthy
      ? `all ${checks.length} checks passed${offline ? ' (offline — auth/search skipped)' : ''}`
      : `${failed.length} check(s) failed: ${failed.join(', ')}`;

    return ok('doctor', { healthy, checks, summary });
  } catch (e) {
    return err('doctor', 'DOCTOR_FAILED', e instanceof Error ? e.message : String(e));
  }
}
