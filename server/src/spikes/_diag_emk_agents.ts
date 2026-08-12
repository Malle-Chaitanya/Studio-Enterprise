/** List every agent with a given display name, with its Reasoning Engine. Read-only. */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';
const PROJECT = 'studio-enterprise-migration';
const ENGINE = 'gemini-enterprise-17847887_1784788734248';
const NAME = process.argv[2] ?? 'Enterprise Migration Knowledge';
const raw = config.GOOGLE_SA_KEY_JSON?.trim() ? config.GOOGLE_SA_KEY_JSON : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
const k = JSON.parse(raw) as { client_email: string; private_key: string };
const { access_token } = await new JWT({ email: k.client_email, key: k.private_key, scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).authorize();
const base = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/engines/${ENGINE}/assistants/default_assistant/agents`;
const r = await fetch(base, { headers: { Authorization: `Bearer ${access_token!}` } });
const j = await r.json() as any;
for (const a of (j.agents ?? []).filter((a: any) => (a.displayName ?? '') === NAME)) {
  const id = String(a.name).split('/').pop();
  const re = a.adkAgentDefinition?.provisionedReasoningEngine?.reasoningEngine
          ?? a.managedAgentDefinition?.provisionedReasoningEngine?.reasoningEngine ?? '(none)';
  console.log(`${id}  state=${a.state ?? '-'}  re=${String(re).split('/').pop()}`);
}
process.exit(0);
