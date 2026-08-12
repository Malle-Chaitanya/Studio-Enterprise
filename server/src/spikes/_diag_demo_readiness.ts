/**
 * Demo preflight for the four target connectors: Jira, Confluence, SharePoint, HubSpot.
 *
 * A demo fails on the boring things — a credential nobody saved, a Google token that
 * expired, a quota already spent — not on the mapping work. This checks each one WITHOUT
 * creating anything, and prints a blocker list in the order it would bite.
 *
 * Read-only: reads Dataverse, the credential index (ids only, never values), and the
 * migration DB. Creates nothing, deploys nothing.
 *
 * npx tsx src/spikes/_diag_demo_readiness.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken, discoverEnvironments } from '../auth/microsoft.js';
import { listBots, extractAgent } from '../services/dataverse.js';
import { listConnectorCredentials } from '../db/repos/connectorCredentials.js';
import { DEFAULT_APP_USER_ID } from '../sessionStore.js';

const TARGETS: Record<string, RegExp> = {
  Jira: /jira/i,
  Confluence: /confluence/i,
  SharePoint: /sharepoint|onedrive/i,
  HubSpot: /hubspot/i,
};

await connectMongo();
const db = getDb();
const cache = (await db.collection('environmentsCache').find({ tenantId: { $exists: true } })
  .sort({ $natural: -1 }).limit(1).next()) as { tenantId?: string; appUserId?: string } | null;
const tenantId = cache!.tenantId!;
const appUserId = cache?.appUserId ?? DEFAULT_APP_USER_ID;

const blockers: string[] = [];
const ready: string[] = [];

// ── 1. Which agents demo which connector ────────────────────────────────────────────
const agentsFor = new Map<string, string[]>();
const connectorsSeen = new Set<string>();
const unreadable: string[] = [];
for (const env of await discoverEnvironments(tenantId)) {
  let token: string;
  let bots: Awaited<ReturnType<typeof listBots>>;
  try { token = await clientCredsToken(tenantId, env.url); bots = await listBots(env.url, token); }
  catch { unreadable.push(env.name); continue; }
  for (const bot of bots) {
    const ir = await extractAgent(env.url, token, bot).catch(() => null);
    if (!ir) continue;
    const blob = JSON.stringify({ t: ir.agentTools ?? [], k: ir.knowledgeSources ?? [] });
    for (const [name, re] of Object.entries(TARGETS)) {
      if (!re.test(blob)) continue;
      agentsFor.set(name, [...(agentsFor.get(name) ?? []), `${ir.name} [${env.name}]`]);
    }
    for (const t of ir.agentTools ?? []) if (t.connectorId) connectorsSeen.add(t.connectorId);
  }
}

// ── 2. Credentials saved? (ids only — never a value) ────────────────────────────────
const creds = await listConnectorCredentials(appUserId);
const savedIds = new Set(creds.map((c) => c.connectorId));

console.log(`\n${'='.repeat(78)}\n  DEMO PREFLIGHT — Jira · Confluence · SharePoint · HubSpot\n${'='.repeat(78)}`);
for (const [name, re] of Object.entries(TARGETS)) {
  const agents = agentsFor.get(name) ?? [];
  const saved = [...savedIds].filter((id) => re.test(id));
  console.log(`\n  ${name}`);
  console.log(`    agents:      ${agents.length ? agents.join(', ') : 'NONE FOUND'}`);
  console.log(`    credentials: ${saved.length ? saved.join(', ') : 'NOT SAVED'}`);
  if (!agents.length) blockers.push(`${name}: no agent in a readable environment uses it — nothing to demo.`);
  else if (!saved.length) blockers.push(`${name}: no credentials saved — the migrated agent will deploy with this tool missing. Save them on the Connectors screen.`);
  else ready.push(`${name} (${agents.length} agent(s))`);
}

// SharePoint's tools run on the shared Microsoft app credential, not a SharePoint-only one.
const msSaved = [...savedIds].some((id) => /sharepointonline|onedrive/.test(id));
if (!msSaved) blockers.push('SharePoint: the Microsoft app credential (tenant/client id/secret) is what both the copy path and the live tools use — without it neither runs.');

// ── 3. Google side: is the connection still usable? ─────────────────────────────────
const session = (await db.collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as
  { gAccessToken?: string; gRefreshToken?: string; geminiProject?: string; environments?: unknown[] } | null;
console.log(`\n  Google destination`);
console.log(`    project:       ${session?.geminiProject ?? '(none on the latest session)'}`);
console.log(`    access token:  ${session?.gAccessToken ? 'present' : 'MISSING'}`);
console.log(`    refresh token: ${session?.gRefreshToken ? 'present' : 'MISSING'}`);
if (!session?.gRefreshToken) {
  blockers.push('Google: the session has no refresh token, so the access token dies about an hour after sign-in. Reconnect Google immediately before the demo.');
}

// ── 4. Quota — agent creation is the cap that has actually bitten ───────────────────
const since = new Date(Date.now() - 24 * 3600 * 1000);
const created = await db.collection('migrationResults').countDocuments({ createdAt: { $gte: since } });
console.log(`\n  Quota`);
console.log(`    agents created in the last 24h (this DB's record): ${created}`);
if (created >= 5) blockers.push(`Quota: ${created} agent(s) created in the last 24h; Gemini's daily agent-creation cap has stopped a run before. Demo early or expect a pause.`);

console.log(`\n${'─'.repeat(78)}`);
console.log(`READY: ${ready.length ? ready.join(' · ') : 'nothing yet'}`);
console.log(`\nBLOCKERS (${blockers.length}):`);
for (const b of blockers) console.log(`  - ${b}`);
if (unreadable.length) console.log(`\nNOT CHECKED: ${unreadable.length} environment(s) unreadable — ${unreadable.join(', ')}`);
process.exit(0);
