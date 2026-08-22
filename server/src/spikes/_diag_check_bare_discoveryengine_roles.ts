/** Checks the real title/description/permission-count of the BARE (non-"agentspace")
 *  discoveryengine.admin/editor/viewer/user roles, to answer precisely what resource
 *  they actually govern and how that differs from agentspaceAdmin/Editor/User.
 *   npx tsx src/spikes/_diag_check_bare_discoveryengine_roles.ts */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const ROLES = [
  'roles/discoveryengine.admin',
  'roles/discoveryengine.editor',
  'roles/discoveryengine.viewer',
  'roles/discoveryengine.user',
  'roles/discoveryengine.agentspaceAdmin',
  'roles/discoveryengine.agentspaceEditor',
  'roles/discoveryengine.agentspaceUser',
];

async function main() {
  const token = await getSaToken(undefined);
  for (const role of ROLES) {
    const res = await fetch(`https://iam.googleapis.com/v1/${role}`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json() as { title?: string; description?: string; includedPermissions?: string[] };
    const perms = body.includedPermissions ?? [];
    // Sample a few permission prefixes to see which RESOURCE TYPES this role's permissions target.
    const resourceHints = [...new Set(perms.map((p) => p.split('.')[1]).filter(Boolean))].slice(0, 12);
    console.log(`\n=== ${role} ===`);
    console.log(`title: ${body.title}`);
    console.log(`description: ${body.description}`);
    console.log(`total permissions: ${perms.length}`);
    console.log(`resource types touched: ${resourceHints.join(', ')}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
