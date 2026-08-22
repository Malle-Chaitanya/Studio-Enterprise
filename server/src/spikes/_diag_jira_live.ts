/**
 * Is the customer's Jira CLOUD or DATA CENTER, and which endpoints actually answer?
 *
 * It decides the tools. `/rest/api/3/search/jql` exists only on Cloud; Data Center serves
 * `/rest/api/2/search`. 34 agents call "Get list of issues (Datacenter)", so assuming Cloud
 * would ship a search tool that 404s for every one of them.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { getSaToken } from '../auth/google.js';
import { getEntraSecret } from '../services/secretManager.js';

await connectMongo();
const db = getDb();
const rec = (await db.collection('connectorCredentials').findOne({ connectorId: 'shared_jira' })) as
  | { project?: string; secretIds?: Record<string, string> } | null;
if (!rec?.secretIds) { console.log('no Jira credential recorded'); process.exit(1); }
const project = rec.project ?? 'studio-enterprise-migration';
const saToken = await getSaToken();
const c: Record<string, string> = {};
for (const [f, id] of Object.entries(rec.secretIds)) {
  const g = await getEntraSecret(saToken, `projects/${project}/secrets/${id}/versions/latest`);
  if (g.ok && g.plaintext) c[f] = g.plaintext;
}
let base = (c.base_url ?? '').replace(/\/$/, '');
console.log(`base_url : ${base}`);
console.log(`email    : ${c.email}`);
console.log(`token    : ${c.api_token ? `present (${c.api_token.length} chars)` : 'MISSING'}\n`);
const auth = Buffer.from(`${c.email}:${c.api_token}`).toString('base64');
const H = { Authorization: `Basic ${auth}`, Accept: 'application/json' };

async function probe(label: string, url: string, init?: RequestInit) {
  try {
    const res = await fetch(url, { ...init, headers: { ...H, ...(init?.headers ?? {}) } });
    const body = await res.text();
    const head = body.replace(/\s+/g, ' ').slice(0, 110);
    console.log(`  ${String(res.status).padEnd(4)} ${label.padEnd(34)} ${head}`);
    return res.ok ? body : null;
  } catch (e) {
    console.log(`  ERR  ${label.padEnd(34)} ${(e as Error).message.slice(0, 90)}`);
    return null;
  }
}

// Which deployment is this? serverInfo answers definitively.
const info = await probe('serverInfo (deploymentType)', `${base}/rest/api/3/serverInfo`);
if (info) {
  const j = JSON.parse(info) as { deploymentType?: string; version?: string; baseUrl?: string };
  console.log(`\n  DEPLOYMENT: ${j.deploymentType}  version ${j.version}  baseUrl ${j.baseUrl}\n`);
}

console.log('  --- search, both generations ---');
const jql = encodeURIComponent('created >= -365d ORDER BY created DESC');
await probe('v3 /search/jql (Cloud)', `${base}/rest/api/3/search/jql?jql=${jql}&maxResults=2&fields=summary`);
await probe('v3 /search (removed on Cloud)', `${base}/rest/api/3/search?jql=${jql}&maxResults=2`);
await probe('v2 /search (Data Center)', `${base}/rest/api/2/search?jql=${jql}&maxResults=2`);

console.log('\n  --- ListResources: which sites can this token reach ---');
await probe('accessible-resources (OAuth)', 'https://api.atlassian.com/oauth/token/accessible-resources');

console.log('\n  --- projects + one issue ---');
const projects = await probe('project/search', `${base}/rest/api/3/project/search?maxResults=3`);
if (projects) {
  const j = JSON.parse(projects) as { values?: Array<{ key: string; name: string }> };
  console.log(`       ${(j.values ?? []).map((p) => `${p.name} (${p.key})`).join(', ')}`);
}

console.log('\n  --- the three MCP-expanded operations with no tool ---');
await probe('myself (GetCurrentUser)', `${base}/rest/api/3/myself`);
await probe('issuetype (ListIssueTypes_V2)', `${base}/rest/api/3/issuetype`);
await probe('serverInfo as the one resource', `${base}/rest/api/3/serverInfo`);
process.exit(0);
