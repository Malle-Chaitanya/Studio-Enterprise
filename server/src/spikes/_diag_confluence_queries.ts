/**
 * Run all 10 Dataverse queries to find where Confluence space bindings are stored.
 * Usage:  cd server && npx tsx src/spikes/_diag_confluence_queries.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';

const BOT_ID = 'cd560e08-8e90-f111-8077-0022480a981d';

async function dvGet(orgUrl: string, token: string, path: string): Promise<{ status: number; body: string }> {
  const url = `${orgUrl}/api/data/v9.2/${path}`;
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'OData-MaxVersion': '4.0',
        'OData-Version': '4.0',
        Prefer: 'odata.include-annotations=*',
      },
    });
    const body = await res.text();
    return { status: res.status, body };
  } catch (e) {
    return { status: 0, body: `FETCH ERROR: ${(e as Error).message}` };
  }
}

function section(n: number, title: string) {
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  Q${n}: ${title}`);
  console.log('═'.repeat(80));
}

function printResult(status: number, body: string) {
  console.log(`Status: ${status}`);
  if (status === 0 || status >= 400) {
    // Error — print full body (usually short)
    console.log(body.slice(0, 800));
    return;
  }
  try {
    const json = JSON.parse(body);
    const arr = json.value ?? json;
    if (Array.isArray(arr)) {
      console.log(`Count: ${arr.length}`);
      if (arr.length === 0) {
        console.log('(empty)');
      } else {
        // Print each item, truncating large fields
        arr.forEach((item, i) => {
          console.log(`\n  [${i}]`);
          for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
            if (v === null || v === undefined) continue;
            const s = typeof v === 'string' ? v : JSON.stringify(v);
            console.log(`    ${k}: ${s.length > 300 ? s.slice(0, 300) + '…' : s}`);
          }
        });
      }
    } else {
      // Single object
      const s = JSON.stringify(json, null, 2);
      console.log(s.length > 2000 ? s.slice(0, 2000) + '\n…(truncated)' : s);
    }
  } catch {
    console.log(body.slice(0, 1500));
  }
}

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('No session — log in first.');

  // Find the environment that actually has the Confluence_agent (filefuze/default).
  // Some envs (cfmanage) return a valid token but 403 on all OData calls — skip those.
  let orgUrl = '';
  let token = '';
  for (const env of s.environments ?? []) {
    let t: string;
    try { t = await clientCredsToken(s.tenantId ?? '', env.url); } catch { continue; }
    // Probe: try to fetch the specific bot to verify this org has it
    const probe = await fetch(`${env.url}/api/data/v9.2/bots(${BOT_ID})?$select=name`, {
      headers: { Authorization: `Bearer ${t}`, Accept: 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0' },
    });
    if (!probe.ok) {
      console.log(`Skip env "${env.name}" (${probe.status})`);
      continue;
    }
    orgUrl = env.url;
    token = t;
    console.log(`Using env: ${env.name} (${env.url})`);
    break;
  }
  if (!token) throw new Error('No usable environment found that has the target bot.');

  const QUERIES: Array<[string, string]> = [
    [
      "Skill components by schemaname (KS1)",
      `botcomponents?$filter=schemaname eq 'crf37_Confluenceagent.skill.Engineering_ChaitanyaMalleDemoCompanyWiki_0ioUg9wnrKb1GTC6avSgS'`,
    ],
    [
      "Skill components by schemaname (KS2)",
      `botcomponents?$filter=schemaname eq 'crf37_Confluenceagent.skill.Operations_PermissionstestQATestSuite_7l86w6eg671VVg_lDIol3'`,
    ],
    [
      "All botcomponents for agent (no type filter)",
      `botcomponents?$filter=_parentbotid_value eq ${BOT_ID}&$select=name,schemaname,componenttype,data,description&$top=100`,
    ],
    [
      "msdyn_knowledgeconfigurations",
      `msdyn_knowledgeconfigurations?$top=50`,
    ],
    [
      "msdyn_knowledgesources",
      `msdyn_knowledgesources?$top=50`,
    ],
    [
      "connectoractions",
      `connectoractions?$top=50`,
    ],
    [
      "botcomponents — componenttype=Skill string filter",
      `botcomponents?$filter=_parentbotid_value eq ${BOT_ID} and componenttype eq 'Skill'&$top=50`,
    ],
    [
      "botcomponentcollections — parentbotid filter",
      `botcomponentcollections?$filter=parentbotid eq ${BOT_ID}&$top=50`,
    ],
    [
      "environmentvariablevalues (with definition expand)",
      `environmentvariablevalues?$expand=EnvironmentVariableDefinitionId&$top=50`,
    ],
    [
      "solutioncomponents for this bot",
      `solutioncomponents?$filter=_objectid_value eq ${BOT_ID}&$top=50`,
    ],
  ];

  for (let i = 0; i < QUERIES.length; i++) {
    const [title, path] = QUERIES[i];
    section(i + 1, title);
    const r = await dvGet(orgUrl, token, path);
    printResult(r.status, r.body);
  }

  console.log('\n\nDone.');
  process.exit(0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
