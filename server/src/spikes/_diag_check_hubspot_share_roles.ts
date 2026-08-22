/** Checks the real, live Dataverse state behind the "HubSpot Agent" Share dialog screenshot
 *  (Editor: ben@qatestagent.com, Owner: erik@filefuze.co, "Everyone in organization"), to
 *  settle two open questions from docs/design/PERMISSION-MAPPING-ARCHITECTURE.md §2:
 *   1. Does our ACTUAL readAgentPermissions() correctly classify ben's Editor share, and what
 *      does the raw RetrieveSharedPrincipalsAndAccess() AccessMask look like for Editor?
 *   2. When "Editor access" is checked, does it write ONE bundled security role or several
 *      distinct ones (Environment Maker / Agent viewer / Power Automate User / Analytics
 *      Viewer / Agent transcript viewer)? Settles whether "Agent viewer" (Analytics +
 *      Evaluation) is really one native mechanism or two bundled under one UI checkbox.
 *   npx tsx src/spikes/_diag_check_hubspot_share_roles.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { readAgentPermissions } from '../services/dataverse.js';

async function dvGet<T>(url: string, token: string, path: string): Promise<T> {
  const res = await fetch(`${url}/api/data/v9.2/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json() as Promise<T>;
}

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('no session found');

  for (const env of s.environments ?? []) {
    let token: string;
    try { token = await clientCredsToken(s.tenantId ?? '', env.url); } catch { continue; }

    let bots: { value: { botid: string; name: string }[] };
    try { bots = await dvGet(env.url, token, `bots?$select=botid,name&$filter=statecode eq 0`); } catch { continue; }
    const match = bots.value.find((b) => /hubspot/i.test(b.name));
    if (!match) continue;

    console.log(`\n=== ENV: ${env.name} (${env.url}) — bot "${match.name}" (${match.botid}) ===`);

    console.log('\n--- 1. readAgentPermissions() — our ACTUAL production extraction function ---');
    const perms = await readAgentPermissions(env.url, token, match.botid);
    console.log(JSON.stringify(perms, null, 2));

    console.log('\n--- 2. Raw RetrieveSharedPrincipalsAndAccess() (unprocessed) ---');
    const raw = await dvGet<{ PrincipalAccesses?: unknown[]; value?: unknown[] }>(
      env.url, token, `bots(${match.botid})/Microsoft.Dynamics.CRM.RetrieveSharedPrincipalsAndAccess()`,
    );
    console.log(JSON.stringify(raw, null, 2));

    console.log('\n--- 3. Raw bot columns relevant to chat policy ---');
    const botRow = await dvGet<Record<string, unknown>>(
      env.url, token, `bots(${match.botid})?$select=accesscontrolpolicy,authorizedsecuritygroupids,_ownerid_value`,
    );
    console.log(JSON.stringify(botRow, null, 2));

    console.log("\n--- 4. ben@qatestagent.com's actual systemuserroles (what Editor-checked really wrote) ---");
    const users = await dvGet<{ value: { systemuserid: string; internalemailaddress: string }[] }>(
      env.url, token, `systemusers?$select=systemuserid,internalemailaddress&$filter=internalemailaddress eq 'ben@qatestagent.com'`,
    );
    const ben = users.value[0];
    if (!ben) { console.log('  ben@qatestagent.com not found as a systemuser in this environment.'); }
    else {
      const roles = await dvGet<{ value: { name: string; roleid: string }[] }>(
        env.url, token, `systemusers(${ben.systemuserid})/systemuserroles_association?$select=name,roleid`,
      );
      console.log(`  Roles currently assigned to ben: ${roles.value.map((r) => r.name).join(', ') || '(none)'}`);
    }
    process.exit(0);
  }
  throw new Error('HubSpot Agent bot not found in any connected environment');
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
