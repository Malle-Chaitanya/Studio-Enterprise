/** Does resolveDestination pick an engine that can actually host agents?
 *  npx tsx src/spikes/_test_resolve_destination.ts [project] */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';
import { resolveDestination } from '../services/gemini.js';
const P = process.argv[2] ?? 'studio-enterprise-migration';
const raw = config.GOOGLE_SA_KEY_JSON?.trim() ? config.GOOGLE_SA_KEY_JSON : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
const k = JSON.parse(raw) as { client_email: string; private_key: string };
const { access_token } = await new JWT({ email: k.client_email, key: k.private_key, scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).authorize();
const d = await resolveDestination(P, access_token!);
console.log(`resolved engine: ${d.engine}`);
const r = await fetch(`https://discoveryengine.googleapis.com/v1alpha/projects/${P}/locations/global/collections/default_collection/engines/${d.engine}/assistants/${d.assistant}`, { headers: { Authorization: `Bearer ${access_token}` } });
console.log(`assistant reachable: ${r.status === 200 ? 'YES' : `NO (${r.status})`}`);
process.exit(r.status === 200 ? 0 : 1);
