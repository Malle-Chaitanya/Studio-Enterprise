/**
 * The exact Domain-Wide Delegation scope line a customer must paste, computed from what
 * their agents actually use — not from a hand-maintained list.
 *
 * WHY THIS IS WORTH COMPUTING. `ConnectorDef.requiredPermissions` is typed by hand in
 * registry.ts (41 of them today). That list cannot track Google, it is per-connector rather
 * than per-migration, and it is necessarily the UNION of everything the connector can do —
 * so an agent that only reads mail still asks the admin for send rights. Google publishes
 * the scopes for every method in its Discovery documents, so the real answer is derivable:
 * take the operations THIS migration will actually call, and solve for the narrowest set of
 * scopes that covers them.
 *
 * That is a set-cover problem (every method accepts any ONE of several scopes), so this
 * runs a greedy cover with a narrowness tie-break. Narrowness is measured, not declared:
 * a scope's breadth is how many methods across the whole API it would unlock, straight out
 * of the Discovery doc. No hardcoded "readonly is narrower" table to drift.
 *
 *   cd server && npx tsx src/spikes/_probe_google_scope_plan.ts
 *   cd server && npx tsx src/spikes/_probe_google_scope_plan.ts --ops files.list,files.get
 *   cd server && npx tsx src/spikes/_probe_google_scope_plan.ts --appUser <id>
 *
 * Read-only: reads stagedAgents, fetches public Discovery docs (no auth). Writes nothing.
 */
import { connectMongo } from '../db/mongo.js';
import { getDb, closeDb, isDbConnected } from '../db/core.js';
import { config } from '../config.js';

const argv = process.argv.slice(2);
const argOf = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

/** Discovery doc URLs for the Google APIs our connectors front. */
const DISCOVERY: Record<string, { api: string; url: string }> = {
  shared_googledrive: { api: 'drive', url: 'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest' },
  shared_gmail: { api: 'gmail', url: 'https://gmail.googleapis.com/$discovery/rest?version=v1' },
  shared_googlecalendar: { api: 'calendar', url: 'https://calendar-json.googleapis.com/$discovery/rest?version=v3' },
  shared_googlecontacts: { api: 'people', url: 'https://people.googleapis.com/$discovery/rest?version=v1' },
  shared_googlechat: { api: 'chat', url: 'https://chat.googleapis.com/$discovery/rest?version=v1' },
};

interface DiscMethod { id?: string; httpMethod?: string; path?: string; scopes?: string[] }

/** Flatten a Discovery doc's arbitrarily nested resources into `files.list` -> method. */
function flattenMethods(doc: Record<string, unknown>): Record<string, DiscMethod> {
  const out: Record<string, DiscMethod> = {};
  const walk = (node: Record<string, unknown>, prefix: string): void => {
    const resources = (node.resources ?? {}) as Record<string, Record<string, unknown>>;
    for (const [rname, res] of Object.entries(resources)) {
      const methods = (res.methods ?? {}) as Record<string, DiscMethod>;
      for (const [mname, m] of Object.entries(methods)) out[`${prefix}${rname}.${mname}`] = m;
      walk(res, `${prefix}${rname}.`);
    }
  };
  walk(doc, '');
  return out;
}

/**
 * Power Platform operation id -> Google Discovery method, by shape of the NAME.
 *
 * The staged agents carry Microsoft's connector vocabulary (`ListFolder`, `CreateFileV2`),
 * not Google's (`files.list`, `files.create`) — the Copilot connector is a wrapper, and the
 * two namespaces never meet. This is a HEURISTIC and is reported as one: an operation it
 * cannot place is listed as unresolved rather than dropped, because a silently skipped
 * operation would understate the scopes and the admin would grant too little — which fails
 * at inference time, not at save time.
 */
const VERB_MAP: Record<string, string> = {
  list: 'list', get: 'get', create: 'create', delete: 'delete', update: 'update',
  copy: 'copy', extract: 'create', move: 'update', find: 'list', search: 'list',
  send: 'send', reply: 'create', add: 'create', remove: 'delete', patch: 'patch',
};

function guessMethod(opId: string, methods: Record<string, DiscMethod>): string[] {
  // `GetFileContentByPath` -> ['get','file','content','by','path']; drop a trailing V2/V3.
  const words = opId
    .replace(/V\d+$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s_]+/)
    .filter(Boolean);
  if (!words.length) return [];
  const verb = VERB_MAP[words[0]];
  if (!verb) return [];

  // Score every Discovery method: the trailing segment must be the mapped verb, and the
  // resource segment should share a noun with the operation id.
  const nouns = new Set(words.slice(1).map((w) => w.replace(/s$/, '')));
  // An API's dominant resource — the one carrying the most methods — breaks ties that the
  // noun alone cannot. `ListFolder` shares no noun with `files`, and without this it scored
  // equal to `changes.list` and lost on alphabetical luck. Drive's dominant resource IS
  // `files`, and that is derived here, not declared.
  const resourceCount = new Map<string, number>();
  for (const name of Object.keys(methods)) {
    const r = name.split('.').slice(-2)[0] ?? '';
    resourceCount.set(r, (resourceCount.get(r) ?? 0) + 1);
  }
  const dominant = [...resourceCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  const hits: { name: string; score: number }[] = [];
  for (const name of Object.keys(methods)) {
    const parts = name.split('.');
    if (parts[parts.length - 1] !== verb) continue;
    const resource = (parts[parts.length - 2] ?? '').toLowerCase().replace(/s$/, '');
    let score = 1;
    if (nouns.has(resource)) score += 3;
    if (parts.slice(-2)[0] === dominant) score += 2;
    // Prefer the shallowest resource: `files.list` over `files.permissions.list`.
    score -= parts.length * 0.1;
    hits.push({ name, score });
  }
  hits.sort((a, b) => b.score - a.score);
  const best = hits.filter((h) => h.score === hits[0]?.score).map((h) => h.name);
  return best.length === 1 ? best : best.slice(0, 1); // ambiguity resolved by score order
}

/**
 * Scopes that restrict the RESOURCE SURFACE rather than the capability.
 *
 * This list is policy, and saying so matters. The first version of this probe ranked
 * narrowness purely by how many methods a scope unlocks, on the theory that fewer methods
 * means less power. That produced `drive.appdata` as the recommended grant for eleven real
 * Drive operations — it covers six of them and looks beautifully narrow, and it would have
 * been a disaster: `appdata` reaches only the application's own hidden folder, so every
 * tool would have failed on the customer's actual files, after the admin had already
 * pasted the line.
 *
 * Google does not machine-declare which scopes are surface-restricted, so no amount of
 * reading the Discovery doc recovers this. It has to be stated, and stated visibly, rather
 * than dressed up as something derived. A scope here is never chosen unless a used method
 * accepts nothing else.
 */
/**
 * A CAPABILITY suffix says "how much may you do"; anything else qualifies the SURFACE —
 * "which subset of things may you touch". Only capability suffixes are safely
 * substitutable for one another.
 *
 * This vocabulary is short and stable, which is the point: the first attempt at this was a
 * deny-list of known-bad scopes, and it failed twice in a row. It recommended
 * `drive.appdata` (the app's own hidden folder) for eleven real Drive operations; once that
 * was blocked by name it recommended `drive.meet.readonly` (Meet recordings only). Google
 * keeps minting surface scopes, so enumerating them is unwinnable.
 *
 * The structural rule below wins instead: `drive.meet.readonly` carries a DOTTED suffix,
 * and `drive.appdata` / `drive.file` / `drive.metadata` carry a suffix outside this
 * vocabulary. All are surface-qualified by construction, with nothing to keep up to date.
 */
const CAPABILITY = ['readonly', 'send', 'compose', 'insert', 'events', 'modify'];

/** Scope -> tier. Lower is narrower; 99 means surface-restricted, chosen only as a last resort. */
function tierOf(scope: string): number {
  // The legacy full-Gmail scope is a bare host, not an /auth/<api> path.
  if (/^https:\/\/mail\.google\.com\/?$/.test(scope)) return CAPABILITY.length;
  const m = /\/auth\/([^/]+)$/.exec(scope);
  if (!m) return 99;
  const parts = m[1].split('.');
  if (parts.length === 1) return CAPABILITY.length; // bare `auth/drive` — full, but general
  const suffix = parts.slice(1).join('.');
  if (suffix.includes('.')) return 99;              // `drive.meet.readonly` — surface-qualified
  const i = CAPABILITY.indexOf(suffix);
  return i >= 0 ? i : 99;                           // `appdata`, `file`, `metadata`, `scripts`
}

/**
 * Greedy set cover: the fewest scopes that satisfy every used method, preferring narrow
 * ones. Ordering is tier first (see above), then measured breadth — how many methods in
 * the WHOLE api a scope unlocks — as the tie-break within a tier.
 */
function planScopes(
  used: string[],
  methods: Record<string, DiscMethod>,
): { chosen: string[]; covers: Record<string, string[]>; uncoverable: string[] } {
  const breadth = new Map<string, number>();
  for (const m of Object.values(methods)) {
    for (const s of m.scopes ?? []) breadth.set(s, (breadth.get(s) ?? 0) + 1);
  }

  const need = new Set(used.filter((u) => (methods[u]?.scopes ?? []).length));
  const uncoverable = used.filter((u) => !(methods[u]?.scopes ?? []).length);
  const chosen: string[] = [];
  const covers: Record<string, string[]> = {};

  while (need.size) {
    const tally = new Map<string, string[]>();
    for (const m of need) {
      for (const s of methods[m].scopes ?? []) {
        tally.set(s, [...(tally.get(s) ?? []), m]);
      }
    }
    // Tier first, then coverage, then measured breadth. Tier leads deliberately: a
    // surface-restricted scope that covers MORE methods is still the wrong answer, so
    // coverage must not be allowed to outvote it.
    const best = [...tally.entries()].sort(
      (a, b) =>
        tierOf(a[0]) - tierOf(b[0]) ||
        b[1].length - a[1].length ||
        (breadth.get(a[0]) ?? 0) - (breadth.get(b[0]) ?? 0),
    )[0];
    if (!best) break;
    chosen.push(best[0]);
    covers[best[0]] = best[1];
    for (const m of best[1]) need.delete(m);
  }

  // Greedy picks narrow-first, so it can choose `drive.readonly` for the reads and then
  // `drive` for the writes — but `drive` already implies the reads, making the first grant
  // dead weight on the line the admin pastes. Drop any scope whose methods are all still
  // covered once it is removed. Broadest-first so the redundant NARROW one is the one that
  // goes, never the other way round.
  const accepts = (s: string, m: string): boolean => (methods[m]?.scopes ?? []).includes(s);
  for (const s of [...chosen].sort((a, b) => tierOf(b) - tierOf(a))) {
    const rest = chosen.filter((c) => c !== s);
    const stillCovered = (covers[s] ?? []).every((m) => rest.some((r) => accepts(r, m)));
    if (stillCovered) {
      chosen.splice(chosen.indexOf(s), 1);
      for (const m of covers[s]) {
        const owner = rest.find((r) => accepts(r, m))!;
        if (!covers[owner].includes(m)) covers[owner].push(m);
      }
      delete covers[s];
    }
  }
  return { chosen, covers, uncoverable };
}

async function discovery(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`discovery ${url} -> HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/** Google connector operations the staged agents actually use, per connector. */
async function usedFromStaged(appUserId?: string): Promise<Record<string, string[]>> {
  const match: Record<string, unknown> = { 'mapped.ir.agentTools.connectorId': { $in: Object.keys(DISCOVERY) } };
  // Multi-tenant rule: scope to one customer when asked. Absent, this is a local survey
  // across whatever is staged, which is why it prints the agent count it drew from.
  if (appUserId) match.appUserId = appUserId;

  const rows = await getDb(config.CSGE_DB)
    .collection('stagedAgents')
    .aggregate([
      { $unwind: '$mapped.ir.agentTools' },
      { $match: match },
      { $group: { _id: { c: '$mapped.ir.agentTools.connectorId', o: '$mapped.ir.agentTools.operationId' } } },
    ])
    .toArray();

  const out: Record<string, string[]> = {};
  for (const r of rows) {
    const { c, o } = (r as { _id: { c: string; o?: string } })._id;
    if (!o) continue;
    (out[c] ??= []).push(o);
  }
  return out;
}

// ── run ──────────────────────────────────────────────────────────────────────
const explicitOps = argOf('--ops');
let perConnector: Record<string, string[]> = {};

if (explicitOps) {
  // `--ops shared_gmail:messages.list,messages.get`, or bare ops for Drive.
  const [maybeConn, rest] = explicitOps.includes(':')
    ? [explicitOps.split(':')[0], explicitOps.split(':').slice(1).join(':')]
    : ['shared_googledrive', explicitOps];
  perConnector = { [maybeConn]: rest.split(',').map((s) => s.trim()).filter(Boolean) };
  console.log(`using ${perConnector[maybeConn].length} operation(s) from --ops on ${maybeConn}\n`);
} else {
  await connectMongo();
  if (!isDbConnected()) {
    console.log('Mongo not reachable — pass --ops files.list,files.get to run offline.');
    process.exit(1);
  }
  perConnector = await usedFromStaged(argOf('--appUser'));
  const n = Object.values(perConnector).reduce((a, b) => a + b.length, 0);
  console.log(`${n} distinct Google operation(s) in use across ${Object.keys(perConnector).length} connector(s)\n`);
}

for (const [connectorId, ops] of Object.entries(perConnector)) {
  const d = DISCOVERY[connectorId];
  if (!d) continue;
  const methods = flattenMethods(await discovery(d.url));

  console.log('='.repeat(72));
  console.log(`${connectorId}  ->  ${d.api}  (${Object.keys(methods).length} Discovery methods)\n`);

  const resolved: string[] = [];
  const unresolved: string[] = [];
  for (const op of [...new Set(ops)].sort()) {
    const guess = guessMethod(op, methods);
    if (guess.length) {
      resolved.push(guess[0]);
      console.log(`  ${op.padEnd(26)} ~> ${guess[0]}`);
    } else {
      unresolved.push(op);
      console.log(`  ${op.padEnd(26)} ~> (unresolved)`);
    }
  }

  const { chosen, covers, uncoverable } = planScopes([...new Set(resolved)], methods);

  // What today's approach would ask for: the union of every scope every used method
  // mentions. The gap between the two numbers IS the least-privilege win.
  const naive = new Set<string>();
  for (const m of new Set(resolved)) for (const s of methods[m]?.scopes ?? []) naive.add(s);

  console.log(`\n  MINIMAL GRANT — ${chosen.length} scope(s), vs ${naive.size} if we asked for every scope mentioned:\n`);
  for (const s of chosen) {
    console.log(`    ${s}`);
    console.log(`        covers: ${covers[s].join(', ')}`);
  }
  if (uncoverable.length) console.log(`\n  no scope declared (public methods?): ${uncoverable.join(', ')}`);
  if (unresolved.length) {
    console.log(`\n  ${unresolved.length} operation(s) UNRESOLVED — scopes below may be incomplete:`);
    console.log(`    ${unresolved.join(', ')}`);
    console.log('    These are Power Platform operation names with no Discovery match. Granting');
    console.log('    too little fails at inference time, not at save time, so resolve these');
    console.log('    before showing the line to a customer.');
  }

  console.log('\n  Paste into Workspace Admin > Security > API controls > Domain-wide delegation');
  console.log(`  (client_id = the service account's numeric id):\n`);
  console.log(`    ${chosen.join(',')}\n`);
}

if (!explicitOps) await closeDb();
process.exit(0);
