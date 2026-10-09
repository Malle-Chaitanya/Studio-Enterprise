import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
const t = await getSaToken();
const res = await fetch(
  'https://us-central1-aiplatform.googleapis.com/v1beta1/projects/agentmigrations/locations/us-central1/reasoningEngines?pageSize=50',
  { headers: { Authorization: `Bearer ${t}` } },
);
const j = (await res.json()) as { reasoningEngines?: { name: string; displayName?: string; createTime?: string; updateTime?: string }[] };
const rows = (j.reasoningEngines ?? []).map((e) => ({
  id: e.name.split('/').pop()!, name: e.displayName ?? '', created: e.createTime ?? '', updated: e.updateTime ?? '',
}));
rows.sort((a, b) => (a.updated < b.updated ? 1 : -1));
for (const r of rows.slice(0, 8)) console.log(`${r.id}  ${r.created}  upd=${r.updated}  ${r.name}`);
process.exit(0);
