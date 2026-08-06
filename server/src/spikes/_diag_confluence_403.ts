/**
 * Diagnose Confluence 403 "caller cannot access Confluence": is it the token's
 * scopes, the account's product access, or the wrong site? Probes v1 + v2 REST,
 * the tenant info endpoint, and a Jira endpoint (works => token fine, Confluence
 * product access missing).
 *
 * npx tsx src/spikes/_diag_confluence_403.ts
 */
import 'dotenv/config';

const BASE = process.env.CONFLUENCE_BASE_URL ?? '';
const EMAIL = process.env.CONFLUENCE_EMAIL ?? '';
const TOKEN = process.env.CONFLUENCE_TOKEN ?? '';
if (!BASE || !EMAIL || !TOKEN) { console.error('missing CONFLUENCE_* env'); process.exit(1); }

const auth = 'Basic ' + Buffer.from(`${EMAIL}:${TOKEN}`, 'utf-8').toString('base64');
console.log(`site=${BASE}  email=${EMAIL}  tokenPrefix=${TOKEN.slice(0, 8)}…  len=${TOKEN.length}`);

const probes: Array<[string, string]> = [
  ['confluence v1 current user', `${BASE}/wiki/rest/api/user/current`],
  ['confluence v1 spaces', `${BASE}/wiki/rest/api/space?limit=5`],
  ['confluence v2 spaces', `${BASE}/wiki/api/v2/spaces?limit=5`],
  ['confluence no-/wiki v1', `${BASE}/rest/api/space?limit=5`],
  ['jira myself (token sanity)', `${BASE}/rest/api/3/myself`],
  ['jira projects', `${BASE}/rest/api/3/project/search?maxResults=5`],
  ['tenant info', `${BASE}/_edge/tenant_info`],
];

for (const [label, url] of probes) {
  try {
    const r = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' } });
    const t = (await r.text()).replace(/\s+/g, ' ');
    console.log(`\n[${r.status}] ${label}`);
    console.log(`  ${t.slice(0, 260)}`);
  } catch (e) {
    console.log(`\n[ERR] ${label}: ${(e as Error).message}`);
  }
}

// Which sites does this token actually cover? (works for scoped tokens)
try {
  const r = await fetch('https://api.atlassian.com/oauth/token/accessible-resources', {
    headers: { Authorization: auth, Accept: 'application/json' },
  });
  console.log(`\n[${r.status}] accessible-resources\n  ${(await r.text()).replace(/\s+/g, ' ').slice(0, 400)}`);
} catch (e) {
  console.log(`\n[ERR] accessible-resources: ${(e as Error).message}`);
}
