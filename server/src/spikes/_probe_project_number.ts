/** Which project number does each candidate project actually have? */
import { getSaToken } from '../auth/google.js';
const t = await getSaToken();
for (const p of ['studio-enterprise-migration', 'gtm-project-504611']) {
  const r = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${p}`, {
    headers: { Authorization: `Bearer ${t}` },
  });
  const b = await r.json() as { projectNumber?: string; name?: string };
  console.log(p, '->', r.status, 'number:', b.projectNumber ?? JSON.stringify(b).slice(0, 120));
}
