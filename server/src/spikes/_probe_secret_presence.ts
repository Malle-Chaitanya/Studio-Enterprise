/** Do the MS-365 group secrets exist in the project this run deploys to? */
import { getSaToken } from '../auth/google.js';
const t = await getSaToken();
for (const p of ['studio-enterprise-migration', 'agentmigrations']) {
  const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${p}/secrets?pageSize=200`,
    { headers: { Authorization: `Bearer ${t}` } });
  const j = await r.json() as { secrets?: Array<{ name: string }> };
  const names = (j.secrets ?? []).map((s) => s.name.split('/').pop() ?? '');
  const ms = names.filter((n) => /ms-graph|ms_graph|office365|graph/i.test(n));
  console.log(`\n${p}: ${names.length} secrets, ${ms.length} ms-graph-ish`);
  ms.slice(0, 8).forEach((n) => console.log('   ', n));
}
