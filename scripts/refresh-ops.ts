// Health-check / refresh the X GraphQL ops config (src/engine/ops.ts).
// X rotates query-ids and the features blob; when the tool starts returning
// NOT_FOUND or FEATURE_DRIFT, run this to see exactly what's stale and, best-
// effort, discover + write the new query-ids from X's web bundles.
//
//   bun run scripts/refresh-ops.ts              # probe each op against X (reliable)
//   bun run scripts/refresh-ops.ts --scan       # also scrape JS bundles for op -> queryId
//   bun run scripts/refresh-ops.ts --scan --write  # write discovered query-ids into ops.ts
//
// Cookies auto-extract from your browser (same as the CLI). Needs a residential IP.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildHeaders } from '../src/engine/auth.ts';
import { getCookies } from '../src/engine/cookies.ts';
import { FEATURES, OPS, encodeParams, graphqlUrl } from '../src/engine/ops.ts';
import type { OpName } from '../src/engine/ops.ts';
import type { XDocument, XElement } from '../src/engine/xctid/index.ts';
import { ClientTransaction, handleXMigration } from '../src/engine/xctid/index.ts';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Probe one op endpoint with empty variables. 404 = stale query-id; 336 = stale features. */
async function probe(ct: ClientTransaction, cookies: ReturnType<typeof getCookies>, op: OpName) {
  const base = graphqlUrl(op);
  const path = new URL(base).pathname;
  const url = `${base}?${encodeParams({ variables: {}, features: FEATURES })}`;
  const txid = await ct.generateTransactionId('GET', path);
  const res = await fetch(url, { headers: buildHeaders({ cookies, transactionId: txid }) });
  const body = await res.text();
  if (res.status === 404) return 'STALE query-id (404)';
  if (res.status === 400 && /features cannot be null/i.test(body)) return 'STALE features (336)';
  return `ok (${res.status})`;
}

/** Best-effort: scrape reachable client-web JS bundles for operationName -> queryId pairs. */
async function scanBundles(doc: XDocument): Promise<Map<string, string>> {
  const urls = new Set<string>();
  for (const s of Array.from(doc.querySelectorAll('script') as ArrayLike<XElement>)) {
    const src = s.getAttribute('src');
    if (src?.includes('client-web')) urls.add(src);
  }
  const html = doc.documentElement.outerHTML;
  for (const m of html.matchAll(
    /https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/[\w./-]+\.js/g,
  )) {
    urls.add(m[0]);
  }

  const found = new Map<string, string>();
  for (const u of urls) {
    try {
      const js = await (await fetch(u)).text();
      for (const m of js.matchAll(/queryId:"([\w-]+)",operationName:"(\w+)"/g)) {
        if (m[2] && m[1]) found.set(m[2], m[1]);
      }
      for (const m of js.matchAll(/operationName:"(\w+)"[^{}]{0,80}?queryId:"([\w-]+)"/g)) {
        if (m[1] && m[2] && !found.has(m[1])) found.set(m[1], m[2]);
      }
    } catch {
      // skip unreachable chunk
    }
  }
  return found;
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const cookies = getCookies();
  const doc = await handleXMigration();
  const ct = await ClientTransaction.create(doc);
  const opNames = Object.keys(OPS) as OpName[];

  console.log('# Health check (probing each op against X)\n');
  let anyStale = false;
  for (const op of opNames) {
    const status = await probe(ct, cookies, op);
    if (status.startsWith('STALE')) anyStale = true;
    console.log(`  ${op.padEnd(26)} ${status}`);
    await sleep(300);
  }
  console.log(anyStale ? '\n⚠️  Some ops are stale.' : '\n✅ All ops current.');

  if (!args.has('--scan')) {
    if (anyStale) console.log('Run with --scan to try to discover new query-ids from the bundles.');
    return;
  }

  console.log('\n# Bundle scan (operationName -> queryId)\n');
  const found = await scanBundles(doc);
  const updates: { op: OpName; from: string; to: string }[] = [];
  for (const op of opNames) {
    const current = OPS[op].queryId;
    const discovered = found.get(OPS[op].operationName);
    if (discovered === undefined) {
      console.log(`  ${op.padEnd(26)} (not found in scanned bundles)`);
    } else if (discovered === current) {
      console.log(`  ${op.padEnd(26)} unchanged`);
    } else {
      console.log(`  ${op.padEnd(26)} ${current} -> ${discovered}`);
      updates.push({ op, from: current, to: discovered });
    }
  }

  if (updates.length === 0) {
    console.log('\nNothing to update from the scan.');
    return;
  }
  if (!args.has('--write')) {
    console.log(`\n${updates.length} change(s) found. Re-run with --write to apply to src/engine/ops.ts.`);
    return;
  }

  const opsPath = join(import.meta.dirname, '..', 'src', 'engine', 'ops.ts');
  let content = readFileSync(opsPath, 'utf8');
  for (const u of updates) {
    content = content.replaceAll(`'${u.from}'`, `'${u.to}'`);
  }
  writeFileSync(opsPath, content);
  console.log(`\n✍️  Wrote ${updates.length} query-id update(s) to src/engine/ops.ts. Re-run the health check to confirm.`);
}

void main();
