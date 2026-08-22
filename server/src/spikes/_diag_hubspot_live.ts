/**
 * What does the customer's real HubSpot answer, for the three operations their agents use?
 *
 * HubSpot has no purpose-built tool module — it falls through to generic_rest.py, i.e. a
 * "call any REST API" tool. That is the exact shape confirmed to fail live for Drive and
 * Confluence: the model declines to construct calls for an API it does not know by heart. So
 * a module has to be written, and it has to be written against measured responses rather
 * than the docs, because the three operations are Independent Publisher connector names whose
 * real endpoints are a guess until probed:
 *
 *   CompaniesList                                    8 agents  shared_hubspotcrm
 *   ListAssociations                                15 agents  shared_hubspotcrmv2
 *   GetTheDailyApiUsageAndLimitsForAHubspotAccount  10 agents  shared_hubspotsettingsv2
 *
 * Read-only. Nothing here creates, updates or deletes a CRM record.
 *
 *   cd server && npx tsx src/spikes/_diag_hubspot_live.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { getSaToken } from '../auth/google.js';
import { getEntraSecret } from '../services/secretManager.js';

await connectMongo();
const db = getDb();
// Any HubSpot record will do: all four ids share the `hubspot` credential group, so they
// resolve to the SAME private app token — that sharing is the thing being relied on here.
const rec = (await db.collection('connectorCredentials').findOne({
  connectorId: { $in: ['shared_hubspotcrm', 'shared_hubspotcrmv2', 'shared_hubspotsettingsv2', 'shared_hubspot'] },
})) as { connectorId?: string; project?: string; secretIds?: Record<string, string> } | null;
if (!rec?.secretIds) {
  console.log('no HubSpot credential recorded');
  process.exit(1);
}
const project = rec.project ?? 'studio-enterprise-migration';
const saToken = await getSaToken();
const field = Object.keys(rec.secretIds)[0];
const got = await getEntraSecret(saToken, `projects/${project}/secrets/${rec.secretIds[field]}/versions/latest`);
if (!got.ok || !got.plaintext) {
  console.log(`could not read the HubSpot token (field ${field}): ${got.error}`);
  process.exit(1);
}
const token = got.plaintext.trim();
console.log(`record   : ${rec.connectorId} (field "${field}")`);
// Never the value — only its shape, which is enough to tell a private-app token from a
// legacy API key without putting a credential in a log.
console.log(`token    : ${token.slice(0, 4)}… ${token.length} chars\n`);

async function probe(label: string, url: string, init?: RequestInit) {
  try {
    const res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
    const body = await res.text();
    console.log(`  ${String(res.status).padEnd(4)} ${label.padEnd(46)} ${body.replace(/\s+/g, ' ').slice(0, 100)}`);
    return res.ok ? body : null;
  } catch (e) {
    console.log(`  ERR  ${label.padEnd(46)} ${(e as Error).message.slice(0, 90)}`);
    return null;
  }
}

console.log('  --- who is this token, and what may it do ---');
// The scopes a private app token carries decide every 403 below, and HubSpot will name them.
await probe('token-info (scopes)', `https://api.hubapi.com/oauth/v1/access-tokens/${encodeURIComponent(token)}`);

console.log('\n  --- GetTheDailyApiUsageAndLimitsForAHubspotAccount (10 agents) ---');
await probe('account-info/v3/api-usage/daily', 'https://api.hubapi.com/account-info/v3/api-usage/daily');
await probe('account-info/v3/details', 'https://api.hubapi.com/account-info/v3/details');

console.log('\n  --- CompaniesList (8 agents) ---');
const companies = await probe(
  'crm/v3/objects/companies',
  'https://api.hubapi.com/crm/v3/objects/companies?limit=3&properties=name,domain,industry',
);

console.log('\n  --- the neighbours an agent needs to be useful at all ---');
await probe('crm/v3/objects/contacts', 'https://api.hubapi.com/crm/v3/objects/contacts?limit=3&properties=email,firstname,lastname');
await probe('crm/v3/objects/deals', 'https://api.hubapi.com/crm/v3/objects/deals?limit=3&properties=dealname,amount,dealstage');
await probe('crm/v3/objects/companies/search (POST)', 'https://api.hubapi.com/crm/v3/objects/companies/search', {
  method: 'POST',
  body: JSON.stringify({ query: 'a', limit: 3, properties: ['name', 'domain'] }),
});

console.log('\n  --- ListAssociations (15 agents) — needs a real object id ---');
let companyId: string | undefined;
if (companies) {
  const j = JSON.parse(companies) as { results?: Array<{ id: string; properties?: Record<string, string> }> };
  companyId = j.results?.[0]?.id;
  console.log(`       first company: ${companyId} "${j.results?.[0]?.properties?.name}"`);
}
if (companyId) {
  // v4 is the current association API; v3 still exists with a different shape, and which one
  // answers decides the tool's URL. Both probed rather than assumed.
  for (const to of ['contacts', 'deals']) {
    await probe(`crm/v4 companies/${companyId}/associations/${to}`,
      `https://api.hubapi.com/crm/v4/objects/companies/${companyId}/associations/${to}?limit=5`);
  }
  await probe(`crm/v3 (legacy) associations`,
    `https://api.hubapi.com/crm/v3/objects/companies/${companyId}/associations/contacts?limit=5`);
  // What association TYPES exist at all — the label an agent would name.
  await probe('crm/v4 associations/company/contact/labels',
    'https://api.hubapi.com/crm/v4/associations/companies/contacts/labels');
}
process.exit(0);
