/** Dump the RAW stream_query event stream — empty answers hide error events.
 *  npx tsx src/spikes/_diag_re_raw_stream.ts <reId> "question" */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';
const RE_ID = process.argv[2]!, Q = process.argv[3] ?? 'What is the VPN access process?';
const P = process.env.E2E_PROJECT ?? 'studio-enterprise-migration', L = 'us-central1';
const raw = config.GOOGLE_SA_KEY_JSON?.trim() ? config.GOOGLE_SA_KEY_JSON : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
const k = JSON.parse(raw) as { client_email: string; private_key: string };
const { access_token } = await new JWT({ email: k.client_email, key: k.private_key, scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).authorize();
const h = { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' };
const re = `https://${L}-aiplatform.googleapis.com/v1beta1/projects/${P}/locations/${L}/reasoningEngines/${RE_ID}`;
const cs = await fetch(`${re}:query`, { method: 'POST', headers: h, body: JSON.stringify({ class_method: 'create_session', input: { user_id: 'diag' } }) });
const sid = /"id":\s*"([^"]+)"/.exec(await cs.text())?.[1];
console.log(`session=${sid}`);
const r = await fetch(`${re}:streamQuery?alt=sse`, { method: 'POST', headers: h, body: JSON.stringify({ class_method: 'stream_query', input: { user_id: 'diag', session_id: sid, message: Q } }) });
const t = await r.text();
console.log(`status=${r.status} bytes=${t.length}\n--- RAW (first 3000) ---\n${t.slice(0, 3000)}`);
