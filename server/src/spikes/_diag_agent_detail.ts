/** What IS this agent? An ADK agent carries a reasoningEngine in its definition; a low-code
 *  fallback agent does not — and a low-code agent has NO connector tools, which is the
 *  difference between a working migration and a green one. */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
const PROJECT = 'studio-enterprise-migration';
const ENGINE = 'gemini-enterprise-17847887_1784788734248';
const id = process.argv[2];
const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || undefined);
const url = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/engines/${ENGINE}/assistants/default_assistant/agents/${id}`;
const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
const j = (await r.json()) as Record<string, any>;
console.log(`GET -> ${r.status}`);
console.log(`displayName = ${j.displayName}`);
console.log(`state       = ${j.state}`);
console.log(`keys        = ${Object.keys(j).join(', ')}`);
const blob = JSON.stringify(j);
const re = blob.match(/reasoningEngines\/(\d+)/);
console.log(`reasoningEngine = ${re ? re[1] : 'NONE  <-- low-code agent, carries no connector tools'}`);
process.exit(0);
