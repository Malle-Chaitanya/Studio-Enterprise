/**
 * Are we fetching EVERYTHING the Copilot Studio UI shows for this agent?
 *
 * The Build screen for "Hubspot agentt" shows four tools each with a Description
 * ("Retrieve a list of HubSpot deals"), Knowledge = "Search all websites", and Memory ON.
 * Extraction reports webBrowsing off, knowledge 0, and the ConnectorTool payload has no
 * description line at all. Either the UI reads them from somewhere we do not, or they are
 * not persisted where we look. Find out which, per field — a migration that recreates the
 * tools without their descriptions gives the model no idea when to call them.
 *
 * Read-only. Prints column names and short values, never tokens.
 *
 * npx tsx src/spikes/_probe_agent_gaps.ts ["<agent name fragment>"]
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken, discoverEnvironments } from '../auth/microsoft.js';
import { listBots } from '../services/dataverse.js';

const NEEDLE = process.argv[2] ?? 'Hubspot agentt';

await connectMongo();
const cache = (await getDb().collection('environmentsCache').find({ tenantId: { $exists: true } })
  .sort({ $natural: -1 }).limit(1).next()) as { tenantId?: string } | null;
const tenantId = cache!.tenantId!;

for (const env of await discoverEnvironments(tenantId)) {
  let token: string;
  let bots: Awaited<ReturnType<typeof listBots>>;
  try {
    token = await clientCredsToken(tenantId, env.url);
    bots = await listBots(env.url, token);
  } catch {
    continue;
  }
  const bot = bots.find((b) => b.name.toLowerCase().includes(NEEDLE.toLowerCase()));
  if (!bot) continue;

  // ── the bot row, every column ──────────────────────────────────────────────────────
  console.log(`\n══ bot row columns (${bot.name})\n`);
  const br = await fetch(`${env.url}/api/data/v9.2/bots(${bot.botid})`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const row = (await br.json()) as Record<string, unknown>;
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith('@') || v === null || v === '') continue;
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    console.log(`  ${k.padEnd(34)} ${s.slice(0, 220)}`);
  }

  // The `configuration` column is where the newer authoring surface keeps agent-level
  // settings. Print it whole — truncating it is how "web search off" got believed.
  console.log('\n══ bot.configuration in full\n');
  console.log(String(row.configuration ?? '(empty)'));

  // ── every component, full payload for the small ones ───────────────────────────────
  console.log(`\n══ components — searching for tool descriptions and web-search config\n`);
  const cr = await fetch(
    `${env.url}/api/data/v9.2/botcomponents?$filter=_parentbotid_value eq ${bot.botid}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
  );
  const comps = ((await cr.json()) as { value?: Array<Record<string, unknown>> }).value ?? [];
  for (const c of comps) {
    const payload = String(c.data || c.content || '');
    const name = String(c.name ?? '(unnamed)');
    const hits: string[] = [];
    // The exact strings the UI showed. If they are not in any payload, the descriptions
    // are not persisted on the bot and must be recovered from the connector swagger.
    if (/Retrieve a list of HubSpot/i.test(payload)) hits.push('TOOL DESCRIPTION TEXT');
    if (/searchAllWebsites|webBrowsing|SearchAllWebsites|allWebsites/i.test(payload)) hits.push('WEB SEARCH FLAG');
    if (/description/i.test(payload)) hits.push('has a `description` key');
    if (/memory/i.test(payload)) hits.push('mentions memory');
    console.log(`  [type ${c.componenttype}] ${name.slice(0, 40).padEnd(40)} ${payload.length} chars  ${hits.join(' · ') || '—'}`);
  }

  // ── does ANY payload contain the description the UI shows? ─────────────────────────
  const anywhere = comps.some((c) => /Retrieve a list of HubSpot/i.test(String(c.data || c.content || '')));
  console.log(`\n  tool Description text present anywhere on this bot: ${anywhere ? 'YES' : 'NO'}`);
  const webAnywhere = comps.some((c) => /webBrowsing|allWebsites/i.test(String(c.data || c.content || '')));
  console.log(`  web-search flag present anywhere on this bot:        ${webAnywhere ? 'YES' : 'NO'}`);
}
process.exit(0);
