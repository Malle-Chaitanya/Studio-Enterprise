/** Orphaned Reasoning Engines relevant to today's Migrate Advisor incident/redeploy. */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';
const PROJECT = 'studio-enterprise-migration', ENGINE = 'gemini-enterprise-17847887_1784788734248', LOC = 'us-central1';
const raw = config.GOOGLE_SA_KEY_JSON?.trim() ? config.GOOGLE_SA_KEY_JSON : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
const k = JSON.parse(raw) as { client_email: string; private_key: string };
const { access_token } = await new JWT({ email: k.client_email, key: k.private_key, scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).authorize();
const tok = access_token!;
const ag = await (await fetch(`https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/engines/${ENGINE}/assistants/default_assistant/agents`, { headers: { Authorization: `Bearer ${tok}` } })).json() as any;
const used = new Set<string>();
for (const a of ag.agents ?? []) {
  const re = a.adkAgentDefinition?.provisionedReasoningEngine?.reasoningEngine;
  if (re) used.add(String(re).split('/').pop()!);
}
const re = await (await fetch(`https://${LOC}-aiplatform.googleapis.com/v1beta1/projects/${PROJECT}/locations/${LOC}/reasoningEngines?pageSize=200`, { headers: { Authorization: `Bearer ${tok}` } })).json() as any;
const all = (re.reasoningEngines ?? []).map((r: any) => ({ id: String(r.name).split('/').pop(), name: r.displayName, created: r.createTime }));
const orphans = all.filter((r: any) => !used.has(r.id));
console.log(`engines=${all.length}  attached=${used.size}  ORPHANED=${orphans.length}`);
const relevant = orphans.filter((o: any) => /migrat|knowledge nexus/i.test(o.name || '') || String(o.created).startsWith('2026-08-16'));
console.log(`relevant to Migrate Advisor / today: ${relevant.length}`);
for (const o of relevant) console.log(`   ${o.id}  "${o.name}"  ${o.created}`);
process.exit(0);
