/** How many agents already exist / how much creation quota is left today? Throwaway. */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';
const PROJECT = 'studio-enterprise-migration';
const ENGINE = 'gemini-enterprise-17847887_1784788734248';
const raw = config.GOOGLE_SA_KEY_JSON?.trim() ? config.GOOGLE_SA_KEY_JSON : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
const k = JSON.parse(raw) as { client_email: string; private_key: string };
const { access_token } = await new JWT({ email: k.client_email, key: k.private_key, scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).authorize();

const url = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/engines/${ENGINE}/assistants/default_assistant/agents`;
const r = await fetch(url, { headers: { Authorization: `Bearer ${access_token!}` } });
const j = await r.json() as any;
const agents = j.agents ?? [];
console.log(`agents on engine: ${agents.length}`);
for (const a of agents) console.log(`  ${a.displayName}  ${(a.name ?? '').split('/').pop()}  state=${a.state ?? '-'}`);

const re = await fetch(`https://us-central1-aiplatform.googleapis.com/v1beta1/projects/${PROJECT}/locations/us-central1/reasoningEngines`, { headers: { Authorization: `Bearer ${access_token!}` } });
const rj = await re.json() as any;
console.log(`\nreasoning engines: ${(rj.reasoningEngines ?? []).length}`);
process.exit(0);
