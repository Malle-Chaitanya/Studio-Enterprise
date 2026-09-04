import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
const PROJECT = 'studio-enterprise-migration';
const admin = await getSaToken();
async function sec(n: string) {
  const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${n}/versions/latest:access`, { headers: { Authorization: `Bearer ${admin}` } });
  if (!r.ok) return `MISSING (${r.status})`;
  const j = (await r.json()) as { payload?: { data?: string } };
  return Buffer.from(j.payload?.data ?? '', 'base64').toString('utf8').trim();
}
console.log('impersonate_email:', await sec('studio-enterprise-shared-teams-impersonate-email'));
process.exit(0);
