/**
 * Write the ms_graph credentials to a local file so a Python tool-test can read them.
 *
 * Exists because inline `npx tsx -e` piped into an env var silently produced an EMPTY value
 * and the failure surfaced as a JSON parse error three layers away. A file is checkable.
 *
 * WRITES A SECRET TO DISK. Point it at a scratch path outside the repo, and delete it after.
 *
 *   cd server && npx tsx src/spikes/_dump_graph_creds.ts <outputPath>
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { getSaToken } from '../auth/google.js';

const OUT = process.argv[2];
if (!OUT) { console.log('usage: _dump_graph_creds.ts <outputPath>'); process.exit(1); }

const PROJECT = 'studio-enterprise-migration';
const admin = await getSaToken();
async function sec(name: string): Promise<string> {
  const r = await fetch(
    `https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${name}/versions/latest:access`,
    { headers: { Authorization: `Bearer ${admin}` } },
  );
  if (!r.ok) throw new Error(`${name}: ${r.status}`);
  const j = (await r.json()) as { payload?: { data?: string } };
  return Buffer.from(j.payload?.data ?? '', 'base64').toString('utf8').trim();
}
const creds = {
  t: await sec('studio-enterprise-ms-graph-tenant-id'),
  ci: await sec('studio-enterprise-ms-graph-client-id'),
  cs: await sec('studio-enterprise-ms-graph-client-secret'),
};
writeFileSync(OUT, JSON.stringify(creds));
// Identity only — never the secret value.
console.log(`wrote creds for tenant ${creds.t} client ${creds.ci} -> ${OUT}`);
process.exit(0);
