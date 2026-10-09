/** Why did the Reasoning Engine build fail? Vertex returns a generic "400 Build failed"
 *  that names nothing; the actual compiler/pip error is in Cloud Build. Read-only. */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = process.env.CSGE_PROJECT ?? 'agentmigrations';
const token = await getSaToken();

const res = await fetch(
  `https://cloudbuild.googleapis.com/v1/projects/${PROJECT}/builds?pageSize=10`,
  { headers: { Authorization: `Bearer ${token}` } },
);
const body = await res.text();
if (!res.ok) { console.log(`builds list -> ${res.status}: ${body.slice(0, 400)}`); process.exit(0); }
const j = JSON.parse(body) as { builds?: { id: string; status: string; createTime: string; logUrl?: string; statusDetail?: string }[] };
for (const b of (j.builds ?? []).slice(0, 6)) {
  console.log(`${b.createTime}  ${b.status.padEnd(10)} ${b.id}  ${b.statusDetail ?? ''}`);
}
const failed = (j.builds ?? []).find((b) => b.status === 'FAILURE');
if (!failed) { console.log('\nno FAILURE build in the last 10'); process.exit(0); }
console.log(`\n=== log tail for ${failed.id} ===`);
const log = await fetch(
  `https://storage.googleapis.com/storage/v1/b/${PROJECT}_cloudbuild/o/log-${failed.id}.txt?alt=media`,
  { headers: { Authorization: `Bearer ${token}` } },
);
const text = await log.text();
if (!log.ok) { console.log(`log fetch -> ${log.status}: ${text.slice(0, 300)}`); process.exit(0); }
const lines = text.split(String.fromCharCode(10));
const interesting = lines.filter((l) => /error|ERROR|Traceback|No matching|conflict|cannot|failed|Exception/i.test(l));
console.log((interesting.length ? interesting : lines).slice(-40).join(String.fromCharCode(10)));
process.exit(0);
