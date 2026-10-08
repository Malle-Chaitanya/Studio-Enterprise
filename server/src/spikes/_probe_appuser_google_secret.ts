/** For ONE appUserId, does the google_service_account group secret exist in each project?
 *  Gmail reads exactly `studio-enterprise-<appUserId>-google-service-account-service-account-json`
 *  from the DESTINATION project at runtime. Anything else present is not a substitute. */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
const APP = process.env.APP_USER_ID || '6a8201ef3adc2441618a9179';
const token = await getSaToken();
for (const project of ['agentmigrations', 'studio-enterprise-migration']) {
  const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${project}/secrets?pageSize=300`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const t = await r.text();
  if (!r.ok) { console.log(`${project}: HTTP ${r.status} ${t.replace(/\s+/g,' ').slice(0,160)}`); continue; }
  const ids = ((JSON.parse(t) as { secrets?: { name: string }[] }).secrets ?? [])
    .map((s) => s.name.split('/').pop()!)
    .filter((n) => n.includes(APP));
  console.log(`\n${project} — ${ids.length} secret(s) for appUserId ${APP}:`);
  ids.sort().forEach((n) => console.log(`  ${n.replace(`studio-enterprise-${APP}-`, '  ')}`));
  const want = `studio-enterprise-${APP}-google-service-account-service-account-json`;
  console.log(`  => google_service_account group key present? ${ids.includes(want) ? 'YES' : 'NO'}`);
}
process.exit(0);
