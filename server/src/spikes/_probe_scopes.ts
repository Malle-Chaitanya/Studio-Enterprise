import { getGoogleAccessToken } from '../auth/google.js';
const out = await getGoogleAccessToken('admin@migrationn.com');
if (!out) { console.log('RESULT null'); process.exit(1); }
const ti = (await (await fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(out.accessToken))).json()) as { scope?: string; expires_in?: string };
console.log('expires_in', ti.expires_in);
for (const s of String(ti.scope ?? '').split(' ')) console.log('  ' + s);
