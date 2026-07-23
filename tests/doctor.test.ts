import { describe, expect, test } from 'bun:test';
import { type DoctorDeps, type DoctorReport, runDoctor } from '../src/commands/doctor.ts';
import { type Engine, EngineError } from '../src/engine/index.ts';
import type { SearchResult, UserProfile } from '../src/types.ts';

/**
 * A minimal Engine stub exposing only the two methods doctor exercises live
 * (whoami + search). Every call is recorded so a test can assert that --offline
 * performs NO network calls. Cast through unknown — doctor never touches the
 * other Engine methods.
 */
function stubEngine(
  handlers: {
    whoami?: () => Promise<UserProfile | null>;
    search?: () => Promise<SearchResult>;
  },
  calls: string[] = [],
): Engine {
  return {
    async whoami() {
      calls.push('whoami');
      return handlers.whoami ? handlers.whoami() : ({ handle: 'me' } as UserProfile);
    },
    async search(query: string) {
      calls.push('search');
      return handlers.search
        ? handlers.search()
        : ({ query, product: 'Top', tweets: [] } as SearchResult);
    },
  } as unknown as Engine;
}

/** Deps that make every environment/entry/cookie check deterministic + offline. */
function greenDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  let clock = 0;
  const now = () => {
    clock += 25;
    return clock;
  };
  return {
    env: { XRELAY_COOKIES: 'auth_token=abc; ct0=def' },
    resolveCookies: () => ({ authToken: 'abc', ct0: 'def' }),
    platform: 'darwin',
    argv1: '/usr/local/bin/xrelay',
    nodeVersion: 'v20.11.0',
    now,
    realpath: () => '/real/dist/cli.js',
    isSymlink: () => true,
    // A shell that carries the `ondemand.s` runtime → bootstrap check passes.
    fetchImpl: (async () =>
      new Response('<html><head><script>var c="ondemand.s"</script></head><body>ok</body></html>', {
        status: 200,
      })) as unknown as typeof fetch,
    ...overrides,
  };
}

const byName = (report: DoctorReport, name: string) => report.checks.find((c) => c.name === name);

describe('runDoctor', () => {
  test('all-green: env cookies present, whoami ok, search ok → healthy, 5 checks', async () => {
    const env = await runDoctor(stubEngine({}), {}, greenDeps());
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('expected Ok envelope');
    expect(env.command).toBe('doctor');
    const report = env.data;
    expect(report.healthy).toBe(true);
    expect(report.checks).toHaveLength(6);
    expect(report.checks.map((c) => c.name)).toEqual([
      'entry',
      'cookies',
      'bootstrap',
      'auth',
      'search',
      'guidance',
    ]);
    expect(report.checks.every((c) => c.ok)).toBe(true);
    expect(byName(report, 'bootstrap')?.detail).toContain('runtime present');
    expect(byName(report, 'auth')?.detail).toContain('me');
  });

  test('never prints cookie values — only booleans/lengths', async () => {
    const env = await runDoctor(
      stubEngine({}),
      {},
      greenDeps({ resolveCookies: () => ({ authToken: 'SECRETTOKEN', ct0: 'SECRETCT0' }) }),
    );
    if (!env.ok) throw new Error('expected Ok envelope');
    const detail = byName(env.data, 'cookies')?.detail ?? '';
    expect(detail).not.toContain('SECRETTOKEN');
    expect(detail).not.toContain('SECRETCT0');
    expect(detail).toContain('auth_token');
    expect(detail).toContain('ct0');
  });

  test('cookie-missing: resolver throws → cookies check fails with the hint, still Ok envelope, live checks still run', async () => {
    const calls: string[] = [];
    const env = await runDoctor(
      stubEngine({}, calls),
      {},
      greenDeps({
        env: {}, // no XRELAY_COOKIES → source is browser extract
        resolveCookies: () => {
          throw new Error(
            'No X cookies found. Log into x.com in Arc/Chrome/Brave/Edge (macOS), or set XRELAY_COOKIES=...',
          );
        },
      }),
    );
    expect(env.ok).toBe(true); // envelope stays Ok-shaped even when a check fails
    if (!env.ok) throw new Error('expected Ok envelope');
    const cookies = byName(env.data, 'cookies');
    expect(cookies?.ok).toBe(false);
    expect(cookies?.detail).toContain('No X cookies found');
    expect(env.data.healthy).toBe(false);
    // whoami + search are still attempted despite the cookie failure.
    expect(calls).toContain('whoami');
    expect(calls).toContain('search');
  });

  test('whoami throws RATE_LIMITED → auth check fails with retryAfterMs, doctor does not throw', async () => {
    const env = await runDoctor(
      stubEngine({
        whoami: () => {
          throw new EngineError('RATE_LIMITED', 'rate limited', 429, 30000);
        },
      }),
      {},
      greenDeps(),
    );
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('expected Ok envelope');
    const auth = byName(env.data, 'auth');
    expect(auth?.ok).toBe(false);
    expect(auth?.detail).toContain('RATE_LIMITED');
    expect(auth?.detail).toContain('30000');
    expect(env.data.healthy).toBe(false);
  });

  test('entry check reports symlink → realpath when isSymlink is true', async () => {
    const env = await runDoctor(
      stubEngine({}),
      {},
      greenDeps({
        argv1: '/usr/local/bin/xrelay',
        realpath: () => '/opt/x-relay/dist/cli.js',
        isSymlink: () => true,
      }),
    );
    if (!env.ok) throw new Error('expected Ok envelope');
    const entry = byName(env.data, 'entry');
    expect(entry?.ok).toBe(true);
    expect(entry?.detail).toContain('/usr/local/bin/xrelay');
    expect(entry?.detail).toContain('symlink → /opt/x-relay/dist/cli.js');
  });

  test('a live check that never resolves times out → failed check, search still attempted, doctor resolves', async () => {
    const calls: string[] = [];
    const env = await runDoctor(
      stubEngine({ whoami: () => new Promise<never>(() => {}) }, calls),
      {},
      greenDeps({ timeoutMs: 10 }),
    );
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('expected Ok envelope');
    const auth = byName(env.data, 'auth');
    expect(auth?.ok).toBe(false);
    expect(auth?.detail).toContain('timed out');
    expect(auth?.detail).toContain('10ms');
    // search still runs after the auth timeout.
    expect(calls).toContain('search');
    expect(env.data.healthy).toBe(false);
  });

  test('--offline: auth + search skipped, no engine calls, healthy from remaining checks', async () => {
    const calls: string[] = [];
    const env = await runDoctor(stubEngine({}, calls), { offline: true }, greenDeps());
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('expected Ok envelope');
    expect(calls).toHaveLength(0); // spy: no live network calls
    expect(byName(env.data, 'bootstrap')?.detail).toContain('skipped');
    expect(byName(env.data, 'auth')?.detail).toContain('skipped');
    expect(byName(env.data, 'search')?.detail).toContain('skipped');
    expect(env.data.healthy).toBe(true);
  });
});
