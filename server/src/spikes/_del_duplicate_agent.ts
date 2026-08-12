/** Delete one gallery agent by id. IRREVERSIBLE — run only on explicit instruction. */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination, deleteAgent } from '../services/gemini.js';
const ID = process.argv[2]!;
const saToken = await getSaToken();
const dest = await resolveDestination(process.env.E2E_PROJECT ?? 'studio-enterprise-migration', saToken);
console.log(JSON.stringify(await deleteAgent(dest, saToken, ID)));
process.exit(0);
