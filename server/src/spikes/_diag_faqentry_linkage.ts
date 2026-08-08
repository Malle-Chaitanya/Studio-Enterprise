/**
 * Follow-up to _diag_find_skill_table.ts: we now know real Dataverse entities
 * dvtablesearch / dvfilesearch / skill / skilldvtablesearch exist. This probes
 * which one (if any) has a record named like "FAQEntry_uPI4VpDKvs4NXzz7WimSu"
 * (the exact string that failed EntityDefinitions resolution in a live run),
 * and dumps that record's attributes to find the field holding the REAL
 * target table/entity name. Also dumps Attributes for Microsoft.Dynamics.CRM.bot
 * to find the real "description" column (Error 3 in the same run).
 *
 *   npx tsx src/spikes/_diag_faqentry_linkage.ts [sessionId]
 *
 * READ-ONLY.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';

const SESSION_ID = process.argv[2];
const NEEDLE = 'FAQEntry_uPI4VpDKvs4NXzz7WimSu';
const BOTID = 'ca57b355-d08b-f111-8076-0022480b19e9';

async function dvGet(url: string, token: string, path: string) {
  const res = await fetch(`${url}/api/data/v9.2/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as { value?: Record<string, unknown>[] } & Record<string, unknown>;
}

const CANDIDATE_SETS = [
  'dvtablesearchs',
  'dvfilesearchs',
  'skills',
  'skilldvtablesearchset',
  'skillmetadatas',
  'aiskillconfigs',
];

async function main() {
  await connectMongo();
  const coll = getDb().collection('migrationSessions');
  const s = (SESSION_ID
    ? await coll.findOne({ _id: SESSION_ID as never })
    : await coll.find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('no session found');

  const env = (s.environments ?? []).find((e) => e.url.includes('org32322095')) ?? s.environments?.[0];
  if (!env) throw new Error('no environment on session');
  const token = await clientCredsToken(s.tenantId ?? '', env.url);
  console.log(`Using env: ${env.name} (${env.url})\n`);

  // 1) Search each candidate set for a record whose primary "name"-ish field contains NEEDLE.
  for (const set of CANDIDATE_SETS) {
    try {
      const nameFieldGuesses = ['name', 'skillname', 'displayname'];
      let found: Record<string, unknown>[] = [];
      for (const f of nameFieldGuesses) {
        try {
          const r = await dvGet(env.url, token, `${set}?$filter=contains(${f},'${NEEDLE.split('_')[0]}')&$top=5`);
          if (r.value?.length) {
            found = r.value;
            console.log(`FOUND in ${set} via $filter contains(${f}, "${NEEDLE.split('_')[0]}"):`);
            break;
          }
        } catch {
          /* field probably doesn't exist on this set, try next */
        }
      }
      if (found.length) {
        for (const rec of found) console.log(JSON.stringify(rec, null, 2));
      } else {
        console.log(`${set}: no name-field match for "${NEEDLE.split('_')[0]}"`);
      }
    } catch (e) {
      console.log(`${set}: query failed — ${(e as Error).message}`);
    }
  }

  // 2) What does the bot's own botcomponents (type = knowledge/skill) look like,
  //    to find the FK from the bot's knowledge source to its dvtablesearch/skill row?
  console.log('\n--- botcomponent rows for this bot (knowledge/skill related) ---');
  try {
    const comps = await dvGet(
      env.url,
      token,
      `botcomponents?$filter=_parentbotid_value eq ${BOTID}&$select=name,schemaname,componenttype&$top=50`,
    );
    for (const c of comps.value ?? []) console.log(JSON.stringify(c));
  } catch (e) {
    console.log('botcomponents query failed:', (e as Error).message);
  }

  // 3) Real Attributes on Microsoft.Dynamics.CRM.bot — find the actual description-ish column.
  console.log('\n--- bot entity Attributes (looking for description-ish columns) ---');
  try {
    const attrs = await dvGet(
      env.url,
      token,
      `EntityDefinitions(LogicalName='bot')/Attributes?$select=LogicalName,DisplayName,AttributeType`,
    );
    const descLike = (attrs.value ?? []).filter((a) =>
      /desc|synopsis|summary|overview|note/i.test(String(a.LogicalName ?? '')),
    );
    console.log(`${attrs.value?.length ?? 0} total attributes, ${descLike.length} description-like:`);
    for (const a of descLike) console.log(`  - ${a.LogicalName} (${a.AttributeType})`);
  } catch (e) {
    console.log('bot Attributes query failed:', (e as Error).message);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
