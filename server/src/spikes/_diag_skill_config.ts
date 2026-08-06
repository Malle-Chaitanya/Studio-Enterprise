/**
 * Dump skillConfiguration from Confluence knowledge source botcomponents.
 * Usage: cd server && npx tsx src/spikes/_diag_skill_config.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { parse as yamlLoad } from 'yaml';

const BOT_ID = 'cd560e08-8e90-f111-8077-0022480a981d';
const ORG_URL = 'https://orga243378d.crm.dynamics.com';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s?.tenantId) throw new Error('No session');

  const tok = await clientCredsToken(s.tenantId, ORG_URL);
  const res = await fetch(
    `${ORG_URL}/api/data/v9.2/botcomponents?$filter=_parentbotid_value eq ${BOT_ID} and componenttype eq 16&$select=name,description,data,schemaname&$top=50`,
    { headers: { Authorization: `Bearer ${tok}`, Accept: 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0' } },
  );
  const json = (await res.json()) as { value?: { name?: string; description?: string; data?: string; schemaname?: string }[] };

  for (const c of json.value ?? []) {
    console.log('\n' + '═'.repeat(80));
    console.log(`name: ${c.name}`);
    console.log(`description: ${c.description}`);
    console.log(`schemaname: ${c.schemaname}`);

    if (!c.data) { console.log('(no data)'); continue; }
    let doc: Record<string, unknown>;
    try { doc = yamlLoad(c.data) as Record<string, unknown>; } catch { console.log('data (raw):', c.data.slice(0, 500)); continue; }

    // Print every key in the parsed YAML
    console.log('\n--- YAML keys ---');
    function printKeys(obj: unknown, prefix = '') {
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
          const fullKey = prefix ? `${prefix}.${k}` : k;
          if (v && typeof v === 'object' && !Array.isArray(v)) {
            printKeys(v, fullKey);
          } else {
            const val = Array.isArray(v) ? JSON.stringify(v) : String(v);
            console.log(`  ${fullKey}: ${val.length > 300 ? val.slice(0, 300) + '…' : val}`);
          }
        }
      }
    }
    printKeys(doc);

    // Print skillConfiguration specifically in full
    const sc = (doc as Record<string, unknown>).skillConfiguration ?? (doc as Record<string, unknown>).SkillConfiguration;
    if (sc !== undefined) {
      console.log('\n--- skillConfiguration (full) ---');
      console.log(typeof sc === 'string' ? sc : JSON.stringify(sc, null, 2));
    }
  }

  process.exit(0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
