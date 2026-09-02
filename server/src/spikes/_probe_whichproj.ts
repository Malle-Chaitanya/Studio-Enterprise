import { getSaToken } from '../auth/google.js';
const t = await getSaToken();
for (const p of ['505103737920', '231705905417']) {
  const r = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${p}`, {
    headers: { Authorization: `Bearer ${t}` },
  });
  const b = await r.json() as Record<string, unknown>;
  console.log(p, '->', r.status, JSON.stringify({ id: b.projectId, num: b.projectNumber, name: b.name }));
}
