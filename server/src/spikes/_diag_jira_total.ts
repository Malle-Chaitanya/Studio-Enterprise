/**
 * Does /search/jql return a real `total`, or just the page size?
 *
 * jira_search reports `total` and its docstring tells the model to quote it when asked
 * "how many". If Atlassian's newer /search/jql endpoint omits total (it is a
 * cursor-paginated API), the fallback `len(issues)` makes the agent answer "we have 20
 * tickets" when there are thousands — a confidently wrong number, which is worse than
 * refusing to count.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { getSaToken } from '../auth/google.js';
import { getEntraSecret } from '../services/secretManager.js';

await connectMongo();
const rec = (await getDb().collection('connectorCredentials').findOne({ connectorId: 'shared_jira' })) as
  | { project?: string; secretIds?: Record<string, string> } | null;
const saToken = await getSaToken();
const c: Record<string, string> = {};
for (const [f, id] of Object.entries(rec?.secretIds ?? {})) {
  const g = await getEntraSecret(saToken, `projects/${rec!.project}/secrets/${id}/versions/latest`);
  if (g.ok && g.plaintext) c[f] = g.plaintext;
}
const base = c.base_url.replace(/\/$/, '');
const auth = Buffer.from(`${c.email}:${c.api_token}`).toString('base64');
const H = { Authorization: `Basic ${auth}`, Accept: 'application/json' };
const jql = encodeURIComponent('created >= -365d ORDER BY created DESC');

for (const mr of [5, 20, 50]) {
  const res = await fetch(`${base}/rest/api/3/search/jql?jql=${jql}&maxResults=${mr}&fields=summary`, { headers: H });
  const j = (await res.json()) as Record<string, unknown>;
  const issues = (j.issues as unknown[] | undefined) ?? [];
  console.log(
    `maxResults=${String(mr).padStart(3)} -> issues=${String(issues.length).padStart(3)}  ` +
    `total=${JSON.stringify(j.total)}  isLast=${JSON.stringify(j.isLast)}  ` +
    `nextPageToken=${j.nextPageToken ? 'present' : 'absent'}`,
  );
}
// The dedicated count endpoint — the correct way to answer "how many".
const cnt = await fetch(`${base}/rest/api/3/search/approximate-count`, {
  method: 'POST',
  headers: { ...H, 'Content-Type': 'application/json' },
  body: JSON.stringify({ jql: 'created >= -365d' }),
});
console.log(`\napproximate-count -> ${cnt.status} ${(await cnt.text()).slice(0, 120)}`);
// Does the OLDER paginated projects API still return a real total?
const pr = await fetch(`${base}/rest/api/3/project/search?maxResults=5`, { headers: H });
const pj = (await pr.json()) as Record<string, unknown>;
console.log(`project/search -> values=${((pj.values as unknown[]) ?? []).length} total=${JSON.stringify(pj.total)} isLast=${JSON.stringify(pj.isLast)}`);
process.exit(0);
