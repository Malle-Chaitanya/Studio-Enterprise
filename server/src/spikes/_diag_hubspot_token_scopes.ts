/**
 * What scopes does a HubSpot private-app token actually carry?
 *
 * A private app's scopes are FIXED at creation and cannot be changed later — adding one means
 * issuing a new token — so knowing what a token holds decides which HubSpot tools can work at
 * all (ledger 1.52: CMS templates 403 named the scopes it wanted).
 *
 * The token is read from HUBSPOT_TOKEN in the environment, never from argv: argv is visible to
 * any process listing on the machine. Nothing here prints the token, and the response is
 * scrubbed before display in case HubSpot echoes it back (it does, in some errors).
 *
 *   HUBSPOT_TOKEN=pat-... npx tsx src/spikes/_diag_hubspot_token_scopes.ts
 */
const token = process.env.HUBSPOT_TOKEN;
if (!token) throw new Error('set HUBSPOT_TOKEN in the environment');

const redact = (s: string) => s.replace(/pat-[A-Za-z0-9-]+/g, 'pat-[redacted]');

// The v2 private-apps endpoint 404s (measured 2026-08-22). The v1 token-info route is the one
// that answers for private-app tokens; the token travels in the PATH there, which is why the
// redactor below exists — any echoed error would otherwise carry it into the log.
const r = await fetch(`https://api.hubapi.com/oauth/v1/access-tokens/${encodeURIComponent(token)}`);
const text = await r.text();
if (!r.ok) {
  console.log(`token-info -> ${r.status}\n${redact(text).slice(0, 500)}`);
} else {
  const j = JSON.parse(text) as { hubId?: number; userId?: number; scopes?: string[]; [k: string]: unknown };
  console.log(`portal (hubId) : ${j.hubId}`);
  console.log(`userId         : ${j.userId ?? '-'}`);
  console.log(`app            : ${String(j.appId ?? j.applicationName ?? '-')}`);
  const scopes = (j.scopes ?? []).slice().sort();
  console.log(`\n${scopes.length} scope(s):`);
  for (const s of scopes) console.log(`  ${s}`);
}

// What the tools this project ships actually need, checked against what the token has.
const NEEDED: Array<[string, string[]]> = [
  ['companies / contacts / deals (hubspot_list_*, get_record, search)', ['crm.objects.companies.read', 'crm.objects.contacts.read', 'crm.objects.deals.read']],
  ['tickets (get_tickets)', ['tickets']],
  ['associations (hubspot_list_associations)', ['crm.objects.companies.read']],
  ['account info / API usage (hubspot_get_account_info)', ['oauth']],
  ['CMS templates (hubspot_list_templates)', ['content', 'design-manager-access', 'content-editor-access', 'landingpages-read']],
];
if (r.ok) {
  const have = new Set(((JSON.parse(text) as { scopes?: string[] }).scopes ?? []));
  console.log('\ntool readiness:');
  for (const [label, any_of] of NEEDED) {
    const hit = any_of.filter((s) => have.has(s));
    console.log(`  ${hit.length ? 'OK  ' : 'MISS'}  ${label}`);
    if (!hit.length) console.log(`          wants one of: ${any_of.join(', ')}`);
  }
}
process.exit(0);
