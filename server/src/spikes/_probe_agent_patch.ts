/** Can an existing agent be repointed at a different Reasoning Engine? */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';
const PROJECT='studio-enterprise-migration', ENGINE='gemini-enterprise-17847887_1784788734248';
const AGENT=process.argv[2]!, RE=process.argv[3]!, APPLY=process.argv.includes('--apply');
const raw = config.GOOGLE_SA_KEY_JSON?.trim() ? config.GOOGLE_SA_KEY_JSON : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
const k = JSON.parse(raw) as { client_email: string; private_key: string };
const { access_token } = await new JWT({ email:k.client_email, key:k.private_key, scopes:['https://www.googleapis.com/auth/cloud-platform'] }).authorize();
const tok = access_token!;
const base = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/engines/${ENGINE}/assistants/default_assistant/agents/${AGENT}`;
const cur = await (await fetch(base, { headers:{Authorization:`Bearer ${tok}`} })).json() as any;
console.log(`current displayName : ${cur.displayName}`);
console.log(`current engine      : ${String(cur.adkAgentDefinition?.provisionedReasoningEngine?.reasoningEngine ?? '-').split('/').pop()}`);
if (!APPLY) { console.log('\n(dry run — pass --apply to repoint)'); process.exit(0); }
const body = {
  displayName: 'Migration Knowledge Advisor',
  adkAgentDefinition: {
    provisionedReasoningEngine: {
      reasoningEngine: `projects/${PROJECT}/locations/us-central1/reasoningEngines/${RE}`,
    },
  },
};
const r = await fetch(`${base}?updateMask=displayName,adkAgentDefinition`, {
  method:'PATCH', headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'}, body: JSON.stringify(body),
});
console.log(`PATCH -> ${r.status}  ${(await r.text()).replace(/\s+/g,' ').slice(0,300)}`);
process.exit(0);
