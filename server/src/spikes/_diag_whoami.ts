/** Print which identity our SA token actually belongs to (SA vs impersonated user)
 *  + its scopes, so we know exactly who needs the Dialogflow role. */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

async function main() {
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || undefined);
  const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`);
  const j = (await r.json()) as Record<string, unknown>;
  console.log('tokeninfo ->', r.status);
  console.log('  email :', j.email ?? j.azp ?? '(none)');
  console.log('  scope :', j.scope ?? '(none)');
  console.log('  GOOGLE_IMPERSONATE_EMAIL =', process.env.GOOGLE_IMPERSONATE_EMAIL || '(unset)');
  console.log('  GOOGLE_AUTH_MODE =', process.env.GOOGLE_AUTH_MODE || '(unset)');
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
