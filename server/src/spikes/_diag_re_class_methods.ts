/**
 * Why do ADK/Reasoning Engine agents 400 on :query? Read what the deployed engines
 * ACTUALLY expose. Every RE resource advertises its callable methods in
 * spec.classMethods[].name — if a deployed ADK app exposes e.g. "stream_query" or
 * "streaming_agent_run_with_events" but we call class_method="query", the platform
 * rejects it and the failure looks like a platform bug when it is a name mismatch.
 *
 * npx tsx src/spikes/_diag_re_class_methods.ts [project] [location]
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';

const PROJECT = process.argv[2] ?? process.env.E2E_PROJECT ?? 'studio-enterprise-migration';
const LOCATION = process.argv[3] ?? 'us-central1';
const HOST = `https://${LOCATION}-aiplatform.googleapis.com/v1beta1`;

const raw = config.GOOGLE_SA_KEY_JSON?.trim() ? config.GOOGLE_SA_KEY_JSON : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
const k = JSON.parse(raw) as { client_email: string; private_key: string };
const { access_token } = await new JWT({ email: k.client_email, key: k.private_key, scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).authorize();
const h = { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' };

const listUrl = `${HOST}/projects/${PROJECT}/locations/${LOCATION}/reasoningEngines?pageSize=100`;
const r = await fetch(listUrl, { headers: h });
if (!r.ok) { console.error(`list failed ${r.status}: ${(await r.text()).slice(0, 300)}`); process.exit(1); }
const j = await r.json() as {
  reasoningEngines?: Array<{
    name: string; displayName?: string; createTime?: string;
    spec?: { classMethods?: Array<Record<string, unknown>>; packageSpec?: unknown; agentFramework?: string };
  }>;
};

const engines = j.reasoningEngines ?? [];
console.log(`${engines.length} reasoning engine(s) in ${PROJECT}/${LOCATION}\n`);

for (const e of engines) {
  const id = e.name.split('/').pop();
  const methods = (e.spec?.classMethods ?? []).map((m) => {
    const name = (m['name'] as string) ?? '?';
    const mode = (m['api_mode'] as string) ?? (m['apiMode'] as string) ?? '';
    return mode ? `${name}[${mode}]` : name;
  });
  console.log(`${id}  ${e.displayName ?? ''}`);
  console.log(`  framework    : ${e.spec?.agentFramework ?? '(unset)'}`);
  console.log(`  createTime   : ${e.createTime ?? ''}`);
  console.log(`  classMethods : ${methods.length ? methods.join(', ') : '(NONE — nothing is callable)'}`);
}
