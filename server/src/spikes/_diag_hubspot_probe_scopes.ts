/**
 * A HubSpot private-app token exposes no scope list through any API (the v1 token-info route
 * rejects the `pat-` format, and the v2 private-apps route 404s — both measured 2026-08-22).
 * So probe instead: call one cheap READ per capability and record what HubSpot answers. A 403
 * body names the scope it wanted, which is the same thing the tools report to the user.
 *
 * Reads the token from HUBSPOT_TOKEN, never argv. Nothing prints the token; every response is
 * scrubbed, because HubSpot echoes the token back inside some 403 bodies (ledger 1.52).
 *
 *   HUBSPOT_TOKEN=pat-... npx tsx src/spikes/_diag_hubspot_probe_scopes.ts
 */
const token = process.env.HUBSPOT_TOKEN;
if (!token) throw new Error('set HUBSPOT_TOKEN in the environment');
const redact = (s: string) => s.replace(/pat-[A-Za-z0-9-]+/g, 'pat-[redacted]');

/** [what it powers, url, the tool in this repo that depends on it] */
const PROBES: Array<[string, string, string]> = [
  ['companies', 'https://api.hubapi.com/crm/v3/objects/companies?limit=1', 'hubspot_list_companies / get_companies'],
  ['contacts', 'https://api.hubapi.com/crm/v3/objects/contacts?limit=1', 'hubspot_list_contacts / get_contacts'],
  ['deals', 'https://api.hubapi.com/crm/v3/objects/deals?limit=1', 'hubspot_list_deals / get_deals'],
  ['tickets', 'https://api.hubapi.com/crm/v3/objects/tickets?limit=1', 'get_tickets'],
  ['owners', 'https://api.hubapi.com/crm/v3/owners?limit=1', '(record ownership in answers)'],
  ['account info', 'https://api.hubapi.com/account-info/v3/details', 'hubspot_get_account_info'],
  ['api usage', 'https://api.hubapi.com/account-info/v3/api-usage/daily', 'hubspot_get_api_usage'],
  ['CMS templates (legacy)', 'https://api.hubapi.com/content/api/v2/templates?limit=1', 'hubspot_list_templates'],
  ['CMS pages (v3)', 'https://api.hubapi.com/cms/v3/pages?limit=1', '(not wired)'],
  ['files', 'https://api.hubapi.com/files/v3/files?limit=1', '(not wired)'],
  ['products', 'https://api.hubapi.com/crm/v3/objects/products?limit=1', '(not wired)'],
  ['line items', 'https://api.hubapi.com/crm/v3/objects/line_items?limit=1', '(not wired)'],
  ['notes/engagements', 'https://api.hubapi.com/crm/v3/objects/notes?limit=1', '(not wired)'],
  ['pipelines (deals)', 'https://api.hubapi.com/crm/v3/pipelines/deals', '(deal stage names)'],
];

console.log('capability'.padEnd(24) + 'HTTP  what it powers');
const missing: string[] = [];
for (const [label, url, tool] of PROBES) {
  let status = 0;
  let body = '';
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    status = r.status;
    body = redact((await r.text()).slice(0, 400));
  } catch (e) {
    body = `network: ${(e as Error).message}`;
  }
  const mark = status === 200 ? 'OK ' : status === 403 ? 'NO ' : '?? ';
  console.log(`${label.padEnd(24)}${mark}${String(status).padEnd(5)} ${tool}`);
  if (status !== 200) {
    // HubSpot names the scope it wanted; that string is the actionable part.
    const m = body.match(/required (?:scopes?|granular scopes?)[^"]*/i) || body.match(/"message":"([^"]{0,220})/);
    if (m) console.log(`      -> ${m[0].replace(/^"message":"/, '').slice(0, 220)}`);
    missing.push(label);
  }
}
console.log(`\n${PROBES.length - missing.length}/${PROBES.length} readable. Not readable: ${missing.join(', ') || '(none)'}`);
process.exit(0);
