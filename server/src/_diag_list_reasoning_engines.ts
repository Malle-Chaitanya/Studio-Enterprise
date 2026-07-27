/** List Vertex AI Agent Runtime reasoning engines (the deployed ADK agents) so we
 *  can get the exact resource path for registration.
 *   npx tsx src/_diag_list_reasoning_engines.ts <project> <location> */
import 'dotenv/config';
import { getSaToken } from './auth/google.js';

const [PROJECT, LOCATION = 'us-west1'] = process.argv.slice(2);

async function listVer(project: string, location: string, ver: string, token: string): Promise<void> {
  const url = `https://${location}-aiplatform.googleapis.com/${ver}/projects/${project}/locations/${location}/reasoningEngines`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const t = await r.text();
  console.log(`\n[${ver}] GET reasoningEngines (${location}) -> ${r.status}`);
  try {
    const j = JSON.parse(t) as { reasoningEngines?: { name: string; displayName?: string; createTime?: string }[] };
    for (const e of j.reasoningEngines ?? []) console.log(`  ${e.name}   "${e.displayName ?? ''}"  ${e.createTime ?? ''}`);
    if (!j.reasoningEngines?.length) console.log('  (none)');
  } catch {
    console.log(`  ${t.replace(/\s+/g, ' ').slice(0, 250)}`);
  }
}

async function main() {
  if (!PROJECT) throw new Error('usage: _diag_list_reasoning_engines.ts <project> [location]');
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || undefined);
  await listVer(PROJECT, LOCATION, 'v1', token);
  await listVer(PROJECT, LOCATION, 'v1beta1', token);
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
