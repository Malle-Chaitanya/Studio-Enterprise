/** Does the requirements list now include the DECIDED surface target? Real DB decisions,
 *  real registry, real helper — the same call the route makes. */
import 'dotenv/config';
import { connectDb } from '../db/core.js';
import { config } from '../config.js';
import { listAgentSurfaceChoices } from '../db/repos/agentSurfaceChoice.js';
import { REGISTRY_BY_ID } from '../connectors/registry.js';
import { expandWithDecidedSurfaceTargets } from '../services/surfaceCredentialRequirements.js';

await connectDb(config.CSGE_DB, 1, 500);
const appUserId = process.env.APP_USER_ID || '6a7168dfc40369e8807f5cc3';
const ids = (process.env.IDS || 'shared_office365,shared_commondataserviceforapps').split(',');
const decided = await listAgentSurfaceChoices(appUserId);
console.log(`decisions on file: ${decided.length}`);
const out = expandWithDecidedSurfaceTargets(ids, decided, (cid) => REGISTRY_BY_ID.has(cid));
console.log(`asked for : ${ids.join(', ')}`);
console.log(`will show : ${out.map((i) => `${i}${REGISTRY_BY_ID.get(i)?.name ? ` (${REGISTRY_BY_ID.get(i)!.name})` : ''}`).join('\n            ')}`);
console.log(out.includes('shared_gmail') ? '\nshared_gmail IS in the list — the Google card will render.' : '\nshared_gmail MISSING — fix does not work.');
process.exit(0);
