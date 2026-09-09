/** Which identity does getSaToken() (no impersonation) actually resolve to? Verify
 *  empirically via Google's tokeninfo endpoint, rather than trust code inspection --
 *  this is the SAME token that successfully listed agents in "agentmigrations" earlier.
 *  npx tsx src/spikes/_diag_verify_token_identity.ts */
import 'dotenv/config';
import { getSaToken, serviceAccountEmail } from '../auth/google.js';

console.log('Code says configured SA email:', serviceAccountEmail() ?? 'not configured');

const token = await getSaToken();
const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${token}`);
const info = await res.json();
console.log('\nActual token identity (from Google, not our own code):');
console.log(JSON.stringify({ email: info.email, scope: info.scope, expires_in: info.expires_in }, null, 2));
process.exit(0);
