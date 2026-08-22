/** Follow-up to _diag_check_hubspot_share_roles.ts: RetrieveSharedPrincipalsAndAccess()
 *  404'd ("Resource not found for the segment") on the HubSpot Agent bot, not a real
 *  permission error. Tries (1) the same function via POST, in case it's bound as an
 *  action here, and (2) the underlying standard Dataverse sharing table
 *  (principalobjectaccessset / POA) directly, filtered by objectid — the mechanism any
 *  row-share populates regardless of whether the higher-level bound function works.
 *   npx tsx src/spikes/_diag_probe_poa_table.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';

async function dvGet(url: string, token: string, path: string, method = 'GET') {
  const res = await fetch(`${url}/api/data/v9.2/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: method === 'POST' ? '{}' : undefined,
  });
  const text = await res.text();
  return { status: res.status, text };
}

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('no session found');

  for (const env of s.environments ?? []) {
    let token: string;
    try { token = await clientCredsToken(s.tenantId ?? '', env.url); } catch { continue; }

    const botsRes = await dvGet(env.url, token, `bots?$select=botid,name&$filter=statecode eq 0`);
    if (botsRes.status !== 200) continue;
    const bots = (JSON.parse(botsRes.text) as { value: { botid: string; name: string }[] }).value;
    const match = bots.find((b) => /hubspot/i.test(b.name));
    if (!match) continue;

    console.log(`\n=== ENV: ${env.name} — bot "${match.name}" (${match.botid}) ===`);

    console.log('\n-- 1. RetrieveSharedPrincipalsAndAccess via POST --');
    const post = await dvGet(env.url, token, `bots(${match.botid})/Microsoft.Dynamics.CRM.RetrieveSharedPrincipalsAndAccess`, 'POST');
    console.log(post.status, post.text.slice(0, 500));

    console.log('\n-- 2. EntityDefinitions: is RetrieveSharedPrincipalsAndAccess bound to bot at all? --');
    const meta = await dvGet(env.url, token, `EntityDefinitions(LogicalName='bot')?$select=LogicalName,IsAuditEnabled&$expand=Attributes($select=LogicalName;$top=1)`);
    console.log(meta.status, meta.text.slice(0, 300));
    // Check the $metadata document directly for the function binding — cheap grep, not a full parse.
    const metaDoc = await fetch(`${env.url}/api/data/v9.2/$metadata`, { headers: { Authorization: `Bearer ${token}` } });
    const metaText = await metaDoc.text();
    const hasFn = metaText.includes('RetrieveSharedPrincipalsAndAccess');
    console.log(`$metadata mentions RetrieveSharedPrincipalsAndAccess: ${hasFn}`);
    if (hasFn) {
      const idx = metaText.indexOf('RetrieveSharedPrincipalsAndAccess');
      console.log('Context:', metaText.slice(Math.max(0, idx - 200), idx + 400));
    }

    console.log('\n-- 3. Standard POA (principalobjectaccess) table, filtered by objectid --');
    const poa = await dvGet(env.url, token, `principalobjectaccessset?$filter=objectid eq ${match.botid}&$select=principalid,accessrightsmask`);
    console.log(poa.status, poa.text.slice(0, 800));

    process.exit(0);
  }
  throw new Error('HubSpot Agent bot not found');
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
