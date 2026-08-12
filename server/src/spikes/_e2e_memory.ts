/**
 * End to end for the memory path, through the real functions the pipeline will call.
 *
 * 1. READ the customer's environment memory for real (this tenant has none — that is the
 *    result, and the code must say "none" rather than "could not look").
 * 2. Run the FULL migrate step against a live reasoning engine using SYNTHESIZED facts in
 *    the exact Dataverse shape, so the write path is proven without touching anyone's
 *    real remembered details.
 * 3. Retrieve them back the way the agent would at inference.
 * 4. Delete everything created.
 *
 * npx tsx src/spikes/_e2e_memory.ts [envUrl] [reasoningEngineId]
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { getSaToken } from '../auth/google.js';
import { attributeMemory, migrateAgentMemory, readEnvironmentMemory } from '../services/memoryExtract.js';
import type { MemoryFactIR } from '../services/memory.js';

const ENV = process.argv[2] ?? 'https://orga243378d.crm.dynamics.com';
const ENGINE = process.argv[3] ?? '7686282818770436096';
const PROJECT = 'studio-enterprise-migration';
const LOCATION = 'us-central1';

await connectMongo();
const cache = (await getDb().collection('environmentsCache').find({ tenantId: { $exists: true } })
  .sort({ $natural: -1 }).limit(1).next()) as { tenantId?: string } | null;
const dvToken = await clientCredsToken(cache!.tenantId!, ENV);
const saToken = await getSaToken();

console.log('1. READ real environment memory');
const real = await readEnvironmentMemory(ENV, dvToken);
if (real === undefined) console.log('   -> table not readable / not present (reported as "could not look", not "none")');
else {
  const { byAgent, unattributed } = attributeMemory(real, ['cd560e08-8e90-f111-8077-0022480a981d']);
  console.log(`   -> ${real.length} fact(s); attributed to migrating agents: ${byAgent.size}; unattributed: ${unattributed.length}`);
}

// Synthesized — the shape Dataverse documents, none of it real.
const SYNTH: MemoryFactIR[] = [
  { id: 'syn-1', subject: 'probe@dest.example', predicate: 'prefers_contact_channel', targetObject: 'email, not chat', privacyLevel: 'Private (user-only)' },
  { id: 'syn-2', subject: 'probe@dest.example', predicate: 'reports_cadence', targetObject: 'weekly on Monday', privacyLevel: 'Shared', ttlSeconds: 172800, createdOn: '2026-08-10T00:00:00Z' },
  { id: 'syn-3', subject: 'unmapped@nowhere.example', predicate: 'salary_band', targetObject: 'senior', privacyLevel: 'Private (user-only)' },
  { id: 'syn-4', subject: 'acme corp', predicate: 'renewal_month', targetObject: 'March', memoryKind: 'inference' },
];
const IDENTITY = new Map([['probe@dest.example', 'probe@dest.example']]);

console.log('\n2. MIGRATE (4 synthetic facts, one of them deliberately unmappable & private)');
const out = await migrateAgentMemory(SYNTH, IDENTITY, {
  project: PROJECT, location: LOCATION, reasoningEngineId: ENGINE, saToken,
});
console.log(`   written: ${out.written}/4`);
for (const n of out.notes) console.log(`   note [${n.status}] ${n.component}: ${n.detail.slice(0, 150)}`);

console.log('\n3. RETRIEVE as the agent would');
const base = `https://${LOCATION}-aiplatform.googleapis.com/v1beta1/projects/${PROJECT}/locations/${LOCATION}/reasoningEngines/${ENGINE}`;
const headers = { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' };
const ret = await fetch(`${base}/memories:retrieve`, {
  method: 'POST', headers, body: JSON.stringify({ scope: { user_id: 'probe@dest.example' } }),
}).then((r) => r.json() as Promise<{ retrievedMemories?: Array<{ memory: { fact: string } }> }>);
for (const m of ret.retrievedMemories ?? []) console.log(`   "${m.memory.fact}"`);

// The unmappable private fact must NOT be retrievable under any scope.
const wide = await fetch(`${base}/memories:retrieve`, {
  method: 'POST', headers, body: JSON.stringify({ scope: { agent_scope: 'all_users' } }),
}).then((r) => r.json() as Promise<{ retrievedMemories?: Array<{ memory: { fact: string } }> }>);
const leaked = (wide.retrievedMemories ?? []).some((m) => m.memory.fact.includes('salary'));
console.log(`   private-unmapped fact leaked into the shared scope? ${leaked ? 'YES — BUG' : 'no'}`);
for (const m of wide.retrievedMemories ?? []) console.log(`   [shared] "${m.memory.fact}"`);

console.log('\n4. DELETE everything created');
const all = await fetch(`${base}/memories`, { headers }).then((r) => r.json() as Promise<{ memories?: Array<{ name: string }> }>);
for (const m of all.memories ?? []) {
  const res = await fetch(`https://${LOCATION}-aiplatform.googleapis.com/v1beta1/${m.name}`, { method: 'DELETE', headers });
  console.log(`   ${m.name.split('/').pop()} -> ${res.status}`);
}

process.exit(0);
