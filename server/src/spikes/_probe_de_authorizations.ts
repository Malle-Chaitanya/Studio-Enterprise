/** Does Discovery Engine expose per-end-user OAuth (Authorizations) on this project? */
import { getSaToken } from '../auth/google.js';
const P = process.argv[2] ?? 'studio-enterprise-migration';
const t = await getSaToken();
for (const loc of ['global']) {
  const url = `https://discoveryengine.googleapis.com/v1alpha/projects/${P}/locations/${loc}/authorizations`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${t}` } });
  const b = await r.text();
  console.log(`GET authorizations [${loc}] ->`, r.status);
  console.log(b.slice(0, 600));
}
