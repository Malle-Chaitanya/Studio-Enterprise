/** Delete superseded agents + their Reasoning Engines. Destructive — --apply required. */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';
const PROJECT = 'studio-enterprise-migration';
const ENGINE = 'gemini-enterprise-17847887_1784788734248';
const LOCATION = 'us-central1';
const KEEP = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '11138074654162485859';
const APPLY = process.argv.includes('--apply');

const raw = config.GOOGLE_SA_KEY_JSON?.trim() ? config.GOOGLE_SA_KEY_JSON : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
const k = JSON.parse(raw) as { client_email: string; private_key: string };
const { access_token } = await new JWT({ email: k.client_email, key: k.private_key, scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).authorize();
const tok = access_token!;

const agentsBase = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/engines/${ENGINE}/assistants/default_assistant/agents`;
const j = await (await fetch(agentsBase, { headers: { Authorization: `Bearer ${tok}` } })).json() as any;
const targets = (j.agents ?? [])
  .filter((a: any) => (a.displayName ?? '') === 'Enterprise Migration Knowledge')
  .map((a: any) => ({
    id: String(a.name).split('/').pop() as string,
    re: String(a.adkAgentDefinition?.provisionedReasoningEngine?.reasoningEngine ?? '').split('/').pop(),
  }))
  .filter((t: any) => t.id !== KEEP);

console.log(`keeping : ${KEEP}`);
console.log(`deleting: ${targets.length} agent(s)\n`);
for (const t of targets) {
  console.log(`  agent ${t.id}   re ${t.re ?? '(none)'}`);
  if (!APPLY) continue;
  const ar = await fetch(`${agentsBase}/${t.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tok}` } });
  console.log(`     agent delete: ${ar.status}${ar.ok ? '' : ' ' + (await ar.text()).slice(0, 150)}`);
  if (t.re) {
    const rr = await fetch(
      `https://${LOCATION}-aiplatform.googleapis.com/v1beta1/projects/${PROJECT}/locations/${LOCATION}/reasoningEngines/${t.re}?force=true`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${tok}` } },
    );
    console.log(`     engine delete: ${rr.status}${rr.ok ? '' : ' ' + (await rr.text()).slice(0, 150)}`);
  }
}
if (!APPLY) console.log('\n(dry run — pass --apply)');
process.exit(0);
