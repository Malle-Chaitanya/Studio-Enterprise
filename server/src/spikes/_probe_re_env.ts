/** What secrets/env the DEPLOYED container actually got. The bake is at deploy time, so this
 *  is the only honest answer to "which credential is the agent using" — a DB row can have
 *  changed since. Prints names/ids only, never values. */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
const PROJECT = process.env.PROJECT || 'agentmigrations';
const LOC = process.env.LOC || 'us-central1';
const RE_ID = process.env.RE_ID || '6963213186019360768';
const token = await getSaToken();
const r = await fetch(
  `https://${LOC}-aiplatform.googleapis.com/v1beta1/projects/${PROJECT}/locations/${LOC}/reasoningEngines/${RE_ID}`,
  { headers: { Authorization: `Bearer ${token}` } },
);
const t = await r.text();
if (!r.ok) { console.log(`HTTP ${r.status} ${t.slice(0, 300)}`); process.exit(1); }
const j = JSON.parse(t) as Record<string, any>;
console.log(`displayName: ${j.displayName}`);
console.log(`updateTime : ${j.updateTime}`);
const spec = j.spec?.deploymentSpec ?? {};
const env = (spec.env ?? []) as { name: string; value?: string }[];
const secretEnv = (spec.secretEnv ?? []) as { name: string; secretRef?: { secret?: string; version?: string } }[];
console.log(`\nenv (${env.length}):`);
for (const e of env) console.log(`  ${e.name} = ${String(e.value ?? '').slice(0, 120)}`);
console.log(`\nsecretEnv (${secretEnv.length}):`);
for (const e of secretEnv) console.log(`  ${e.name} -> ${e.secretRef?.secret}:${e.secretRef?.version}`);
console.log(`\nserviceAccount: ${spec.serviceAccount ?? j.spec?.serviceAccount ?? '(default)'}`);
process.exit(0);
