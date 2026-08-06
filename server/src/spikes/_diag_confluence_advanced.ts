/**
 * Advanced Confluence space-binding discovery: 4 approaches.
 * Usage: cd server && npx tsx src/spikes/_diag_confluence_advanced.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { config } from '../config.js';

const BOT_ID  = 'cd560e08-8e90-f111-8077-0022480a981d';
const ENV_URL = 'https://orga243378d.crm.dynamics.com';
// The Dataverse environment (organization) GUID — visible in the bot row's _organizationid_value
const ORG_ID  = 'ff145e3e-36a3-f011-8706-000d3a10631f';
// Power Platform environment ID format is usually the org GUID without dashes (or check admin portal)
// We'll derive it or try both.

function section(n: number, title: string) {
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  [${n}] ${title}`);
  console.log('═'.repeat(80));
}

async function tryFetch(label: string, url: string, opts: RequestInit): Promise<void> {
  console.log(`URL: ${url}`);
  try {
    const res = await fetch(url, opts);
    const body = await res.text();
    console.log(`Status: ${res.status}`);
    if (!res.ok) {
      console.log('Error body:', body.slice(0, 600));
      return;
    }
    // Pretty-print if JSON
    try {
      const json = JSON.parse(body);
      const s = JSON.stringify(json, null, 2);
      console.log(s.length > 4000 ? s.slice(0, 4000) + '\n…(truncated)' : s);
    } catch {
      console.log(body.slice(0, 3000));
    }
  } catch (e) {
    console.log(`FETCH ERROR: ${(e as Error).message}`);
  }
}

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('No session — log in first.');

  // Get Dataverse token (client credentials)
  const dvToken = await clientCredsToken(s.tenantId ?? '', ENV_URL);
  const dvHeaders = {
    Authorization: `Bearer ${dvToken}`,
    Accept: 'application/json',
    'OData-MaxVersion': '4.0',
    'OData-Version': '4.0',
    'Content-Type': 'application/json',
  };

  // ── Q1: ExportSolution ────────────────────────────────────────────────────
  section(1, 'ExportSolution (Default unmanaged solution)');
  // Note: this returns a base64-encoded zip — we just check if the call works
  // and print the first 2k chars of the base64 (the zip header).
  await tryFetch('ExportSolution', `${ENV_URL}/api/data/v9.2/ExportSolution`, {
    method: 'POST',
    headers: dvHeaders,
    body: JSON.stringify({ SolutionName: 'Default', Managed: false }),
  });

  // ── Q2: Power Platform Admin API ─────────────────────────────────────────
  section(2, 'Power Platform Admin API — connector list');
  // The PP admin API uses a different token scope: https://api.powerplatform.com
  let ppToken = '';
  try {
    ppToken = await clientCredsToken(s.tenantId ?? '', 'https://api.powerplatform.com');
  } catch (e) {
    console.log(`PP admin token error: ${(e as Error).message}`);
  }
  if (ppToken) {
    // Try with ORG_ID as environment id (both with and without dashes)
    const envIdNoDash = ORG_ID.replace(/-/g, '');
    for (const envId of [ORG_ID, envIdNoDash]) {
      console.log(`\nTrying environmentId: ${envId}`);
      await tryFetch('PP connectors', `https://api.powerplatform.com/appmanagement/environments/${envId}/connectors`, {
        headers: { Authorization: `Bearer ${ppToken}`, Accept: 'application/json' },
      });
    }
  }

  // ── Q3: Copilot Studio REST API (preview) ─────────────────────────────────
  section(3, 'Copilot Studio REST API — knowledgesources');
  // Needs token for powerva.microsoft.com
  let pvaToken = '';
  try {
    pvaToken = await clientCredsToken(s.tenantId ?? '', 'https://api.powerva.microsoft.com');
  } catch (e) {
    console.log(`PVA token error: ${(e as Error).message}`);
  }
  if (pvaToken) {
    // Extract environment id from the org URL or try ORG_ID
    for (const envId of [ORG_ID, ORG_ID.replace(/-/g, '')]) {
      const url = `https://api.powerva.microsoft.com/api/botmanagement/v1/environments/${envId}/bots/${BOT_ID}/knowledgesources`;
      console.log(`\nTrying envId: ${envId}`);
      await tryFetch('PVA knowledgesources', url, {
        headers: { Authorization: `Bearer ${pvaToken}`, Accept: 'application/json' },
      });
    }
  }

  // ── Q4: connections table — shared_confluence entries ─────────────────────
  section(4, 'Dataverse connections table — shared_confluence entries');
  await tryFetch('connections', `${ENV_URL}/api/data/v9.2/connections?$filter=connectorid eq '/providers/Microsoft.PowerApps/apis/shared_confluence'&$top=20`, {
    headers: dvHeaders,
  });

  // Bonus: also try connectionreferences filtered to confluence
  section('4b', 'connectionreferences — shared_confluence');
  await tryFetch('connectionreferences', `${ENV_URL}/api/data/v9.2/connectionreferences?$filter=connectorid eq '/providers/Microsoft.PowerApps/apis/shared_confluence'&$top=20`, {
    headers: dvHeaders,
  });

  // Bonus: try the customapirequestparameters or connector entity
  section('4c', 'connectors entity — shared_confluence');
  await tryFetch('connectors', `${ENV_URL}/api/data/v9.2/connectors?$filter=connectorinternalid eq 'shared_confluence'&$top=5`, {
    headers: dvHeaders,
  });

  console.log('\n\nDone.');
  process.exit(0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
