/** Every deployed Reasoning Engine in both projects, with age. A deployed Agent Engine is a
 *  running container billed by uptime — an orphan from a test migration costs the same as a
 *  live one. Read-only: lists, deletes nothing. */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
const LOC = 'us-central1';
const token = await getSaToken();
for (const project of (process.env.PROJECTS || 'agentmigrations,studio-enterprise-migration').split(',')) {
  const r = await fetch(
    `https://${LOC}-aiplatform.googleapis.com/v1beta1/projects/${project}/locations/${LOC}/reasoningEngines?pageSize=200`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const t = await r.text();
  if (!r.ok) { console.log(`\n## ${project}: HTTP ${r.status} ${t.replace(/\s+/g, ' ').slice(0, 160)}`); continue; }
  const list = ((JSON.parse(t) as { reasoningEngines?: any[] }).reasoningEngines ?? [])
    .sort((a, b) => String(b.updateTime).localeCompare(String(a.updateTime)));
  console.log(`\n## ${project}: ${list.length} deployed agent engine(s)`);
  for (const e of list) {
    const days = Math.round((Date.now() - Date.parse(e.createTime ?? e.updateTime)) / 86400000);
    console.log(`   ${String(e.name).split('/').pop().padEnd(21)} ${String(e.displayName ?? '').slice(0, 28).padEnd(29)} created ${String(e.createTime ?? '').slice(0, 10)}  ${days}d old`);
  }
}
process.exit(0);
