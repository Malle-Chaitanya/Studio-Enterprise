/**
 * Generate a ConnectorDef for ANY Google Workspace app from its Discovery document, and
 * check the generator against the two entries that were written by hand.
 *
 * WHY A TEMPLATE WORKS HERE AND NOT FOR MICROSOFT. Power Platform connectors are
 * heterogeneous: OAuth, basic auth, API keys, per-connector token endpoints, per-connector
 * scopes. There is no single shape to template. Google Workspace is the opposite — EVERY
 * app is reached with the same shared service account, the same `Bearer {access_token}`
 * header, and the same domain-wide-delegation subject. That uniformity is what makes a
 * generated ConnectorDef possible: only the identity differs per app, and Discovery
 * publishes all of it.
 *
 * So adding Sheets, Docs, Slides, Tasks, Forms, Meet or Keep should not mean a new registry
 * entry OR a new Python module. It should mean naming the api.
 *
 *   cd server && npx tsx src/spikes/_probe_google_connector_def.ts
 *   cd server && npx tsx src/spikes/_probe_google_connector_def.ts --api sheets
 *   cd server && npx tsx src/spikes/_probe_google_connector_def.ts --verify
 *
 * Read-only. Public Discovery docs, no auth. Prints TypeScript; writes nothing.
 */
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const argOf = (f: string) => (argv.indexOf(f) >= 0 ? argv[argv.indexOf(f) + 1] : undefined);

/**
 * The POLICY half — the part Discovery cannot tell us, because it is a decision about how
 * CloudFuze reaches Google rather than a fact about Google. It is identical for every
 * Workspace app, which is the whole reason this template exists. See registry.ts's
 * shared_gmail entry: these five lines are verbatim what was typed there by hand.
 */
const GOOGLE_POLICY = {
  credentials: [] as string[],            // supplied by the credential group
  credentialGroup: 'google_service_account',
  authHeaderTemplate: 'Bearer {access_token}',
  authKind: 'google-service-account',
  impersonation: { header: '', resolve: 'google-dwd-subject' },
};

/** Cosmetic-only, and the one place a human still chooses something. Defaults are fine. */
const COSMETIC: Record<string, { category: string; icon: string }> = {
  gmail: { category: 'storage', icon: '✉️' },
  drive: { category: 'storage', icon: '\u{1F4C1}' },
};

interface DiscoveryDoc {
  name?: string; title?: string; rootUrl?: string; servicePath?: string;
  documentationLink?: string;
  resources?: Record<string, unknown>;
}

interface DiscMethod { httpMethod?: string; path?: string; scopes?: string[] }

/** Printed in place of a scope when the migration's operation list was not supplied. */
const NEEDS_OPS = '<< computed per migration from the operations actually used >>';

function flatten(doc: Record<string, unknown>): Record<string, DiscMethod> {
  const out: Record<string, DiscMethod> = {};
  const walk = (node: Record<string, unknown>, prefix: string): void => {
    const res = (node.resources ?? {}) as Record<string, Record<string, unknown>>;
    for (const [rn, r] of Object.entries(res)) {
      for (const [mn, m] of Object.entries((r.methods ?? {}) as Record<string, DiscMethod>)) {
        out[`${prefix}${rn}.${mn}`] = m;
      }
      walk(r, `${prefix}${rn}.`);
    }
  };
  walk(doc, '');
  return out;
}

/** Narrow-to-broad capability tiers; a dotted or unknown suffix qualifies the SURFACE and is
 *  never substitutable. Same rule as _probe_google_scope_plan.ts — see its comment for the
 *  two wrong answers that produced it (drive.appdata, then drive.meet.readonly). */
const CAPABILITY = ['readonly', 'send', 'compose', 'insert', 'events', 'modify'];
function tierOf(scope: string): number {
  if (/^https:\/\/mail\.google\.com\/?$/.test(scope)) return CAPABILITY.length;
  const m = /\/auth\/([^/]+)$/.exec(scope);
  if (!m) return 99;
  const parts = m[1].split('.');
  if (parts.length === 1) return CAPABILITY.length;
  const suffix = parts.slice(1).join('.');
  if (suffix.includes('.')) return 99;
  const i = CAPABILITY.indexOf(suffix);
  return i >= 0 ? i : 99;
}

/**
 * The scope this connector should REQUEST at mint time.
 *
 * Critical and easy to get wrong: domain-wide delegation matches scope strings EXACTLY.
 * registry.ts's own hand-written note says it outright — granting the broader
 * `mail.google.com` does NOT satisfy a request for `gmail.modify`. So whatever is computed
 * here has to be BOTH what the connector requests and what the admin is told to grant. Two
 * lists that can drift is exactly the bug class this codebase keeps hitting; this returns
 * one value used for both `scope` and `requiredPermissions` below.
 */
function scopeFor(methods: Record<string, DiscMethod>, used?: string[]): string[] {
  const pool = used?.length ? used.filter((u) => methods[u]) : Object.keys(methods);
  const need = new Set(pool.filter((m) => (methods[m].scopes ?? []).length));
  const breadth = new Map<string, number>();
  for (const m of Object.values(methods)) for (const s of m.scopes ?? []) breadth.set(s, (breadth.get(s) ?? 0) + 1);

  const chosen: string[] = [];
  while (need.size) {
    const tally = new Map<string, string[]>();
    for (const m of need) for (const s of methods[m].scopes ?? []) tally.set(s, [...(tally.get(s) ?? []), m]);
    const best = [...tally.entries()].sort(
      (a, b) => tierOf(a[0]) - tierOf(b[0]) || b[1].length - a[1].length ||
                (breadth.get(a[0]) ?? 0) - (breadth.get(b[0]) ?? 0),
    )[0];
    if (!best) break;
    chosen.push(best[0]);
    for (const m of best[1]) need.delete(m);
  }
  // Drop a scope that a broader chosen one already implies.
  for (const s of [...chosen].sort((a, b) => tierOf(b) - tierOf(a))) {
    const rest = chosen.filter((c) => c !== s);
    const covered = pool.filter((m) => (methods[m].scopes ?? []).includes(s))
      .every((m) => rest.some((r) => (methods[m].scopes ?? []).includes(r)));
    if (covered && rest.length) chosen.splice(chosen.indexOf(s), 1);
  }
  return chosen;
}

function generate(api: string, doc: DiscoveryDoc, used?: string[]): Record<string, unknown> {
  const methods = flatten(doc as Record<string, unknown>);
  // Without the operations this migration actually calls there is no least-privilege answer
  // to compute, and solving over the api's WHOLE surface produces a confident, over-broad
  // one. Observed on the first run: Sheets came back wanting `auth/drive` -- every file in
  // the customer's Drive -- because several Sheets methods accept it and the tie broke
  // arbitrarily. Same failure shape as the `drive.appdata` recommendation in
  // _probe_google_scope_plan.ts: plausible output, wrong grant, and it fails late.
  // So this refuses rather than guesses. The scope is a per-MIGRATION fact, not a
  // per-connector one, which is the whole argument for computing it.
  const scopes = used?.length ? scopeFor(methods, used) : [];
  const base = `${(doc.rootUrl ?? '').replace(/\/$/, '')}/${(doc.servicePath ?? '').replace(/\/$/, '')}`;
  const cos = COSMETIC[api] ?? { category: 'storage', icon: '\u{1F517}' };
  return {
    id: api === 'gmail' ? 'shared_gmail' : `shared_google${api}`,
    name: (doc.title ?? api).replace(/ API$/, ''),
    category: cos.category,
    icon: cos.icon,
    docsUrl: doc.documentationLink,
    requiredPermissions: scopes.length ? scopes : NEEDS_OPS,
    credentials: GOOGLE_POLICY.credentials,
    credentialGroup: GOOGLE_POLICY.credentialGroup,
    baseUrlTemplate: base.replace(/\/$/, ''),
    authHeaderTemplate: GOOGLE_POLICY.authHeaderTemplate,
    authKind: GOOGLE_POLICY.authKind,
    scope: scopes.length ? scopes.join(' ') : NEEDS_OPS,
    impersonation: GOOGLE_POLICY.impersonation,
  };
}

/** Pull the hand-typed entry out of registry.ts so the generator can be checked against it. */
function handTyped(connectorId: string): Record<string, string> {
  const src = readFileSync('src/connectors/registry.ts', 'utf8');
  const start = src.indexOf(`id: '${connectorId}'`);
  if (start < 0) return {};
  const next = src.indexOf("id: 'shared_", start + 10);
  const seg = src.slice(start, next > 0 ? next : start + 4000);
  const out: Record<string, string> = {};
  for (const key of ['name', 'category', 'docsUrl', 'baseUrlTemplate', 'authHeaderTemplate',
                     'authKind', 'scope', 'credentialGroup']) {
    const m = new RegExp(`${key}:\\s*'([^']*)'`).exec(seg);
    if (m) out[key] = m[1];
  }
  out.impersonationResolve = /resolve:\s*'([^']+)'/.exec(seg)?.[1] ?? '';
  return out;
}

async function discovery(api: string): Promise<DiscoveryDoc> {
  const idx = (await (await fetch('https://discovery.googleapis.com/discovery/v1/apis?preferred=true')).json()) as
    { items: { name: string; discoveryRestUrl: string }[] };
  const hit = idx.items.find((i) => i.name === api);
  if (!hit) throw new Error(`no Discovery entry for '${api}'`);
  return (await (await fetch(hit.discoveryRestUrl)).json()) as DiscoveryDoc;
}

// The operations real staged agents use, so the generated scope is the one this migration
// actually needs rather than the connector's whole surface.
const USED: Record<string, string[]> = {
  gmail: ['users.messages.list', 'users.messages.get', 'users.labels.list', 'users.messages.send'],
  drive: ['files.list', 'files.get', 'files.create', 'files.update', 'files.copy', 'files.delete'],
};

// ── run ──────────────────────────────────────────────────────────────────────
if (argv.includes('--verify')) {
  let mismatches = 0;
  for (const [api, connectorId] of [['gmail', 'shared_gmail'], ['drive', 'shared_googledrive']] as const) {
    const gen = generate(api, await discovery(api), USED[api]);
    const hand = handTyped(connectorId);
    console.log(`\n### ${connectorId} — generated vs hand-typed\n`);
    for (const key of ['name', 'category', 'docsUrl', 'baseUrlTemplate', 'authHeaderTemplate',
                       'authKind', 'credentialGroup', 'scope']) {
      const g = String((gen as Record<string, unknown>)[key] ?? '');
      const h = hand[key] ?? '(absent)';
      const same = g === h;
      if (!same) mismatches++;
      console.log(`  ${same ? 'MATCH ' : 'DIFFER'}  ${key}`);
      if (!same) {
        console.log(`           generated: ${g}`);
        console.log(`           hand     : ${h}`);
      }
    }
    const gi = (gen.impersonation as { resolve: string }).resolve;
    const same = gi === hand.impersonationResolve;
    if (!same) mismatches++;
    console.log(`  ${same ? 'MATCH ' : 'DIFFER'}  impersonation.resolve`);
  }
  console.log(`\n${mismatches} field(s) differ. Differences are not necessarily bugs — see the note printed below.\n`);
  console.log('A narrower generated `scope` than the hand-typed one is the generator working:');
  console.log('the hand-typed value is the connector\'s whole surface, the generated one covers');
  console.log('only the operations this migration uses. DWD matches scope strings EXACTLY, so');
  console.log('the SAME value must be requested at mint time and granted in Workspace Admin.');
  process.exit(0);
}

const api = argOf('--api') ?? 'calendar';
const gen = generate(api, await discovery(api), USED[api]);
console.log(`// Generated from the ${api} Discovery document. No hand-typed entry needed.\n`);
console.log(JSON.stringify(gen, null, 2).replace(/"([a-zA-Z]+)":/g, '$1:').replace(/"/g, "'"));
if (!USED[api]) {
  console.log('\n// scope/requiredPermissions are intentionally unfilled: they are a');
  console.log('// per-MIGRATION fact, computed from the operations the agents actually call.');
  console.log('// Solving over the whole api surface gives a confident, over-broad grant --');
  console.log('// Sheets came back asking for auth/drive on the first run.');
}
process.exit(0);
