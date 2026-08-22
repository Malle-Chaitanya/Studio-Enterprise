/** Fetches the real display titles/descriptions of the two IAM roles involved in the
 *  access chain, straight from Google's IAM API, to answer precisely which is which
 *  (rather than guess from memory) — roles/discoveryengine.agentspaceUser (engine-level)
 *  vs roles/discoveryengine.agentUser (per-agent level).
 *   npx tsx src/spikes/_diag_role_titles.ts */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const ROLES = ['roles/discoveryengine.agentspaceUser', 'roles/discoveryengine.agentUser', 'roles/discoveryengine.viewer', 'roles/discoveryengine.user'];

async function main() {
  const token = await getSaToken(undefined);
  for (const role of ROLES) {
    const res = await fetch(`https://iam.googleapis.com/v1/${role}`, { headers: { Authorization: `Bearer ${token}` } });
    console.log(`\n=== ${role} (${res.status}) ===`);
    console.log((await res.text()));
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
