/** Prove the Drive impersonate_email domain-ownership check (routes/migrate.ts's
 *  POST /third-party-connectors/credentials) behaves correctly, using the exact
 *  same function and the exact same domain-extraction logic the route runs —
 *  without needing an app-login session to hit the real HTTP route.
 *  npx tsx src/spikes/_diag_test_drive_domain_check.ts */
import { impersonationAllowed } from '../auth/google.js';

// Real gEmail found on an actual session (B2_zcYeE9t1ySd3U8B9oaJqKbHA).
const G_EMAIL = 'zara@storefuze.com';
const ownDomain = G_EMAIL.split('@')[1]?.toLowerCase();

type Case = { label: string; target: string; expectAllowed: boolean };
const cases: Case[] = [
  { label: 'cross-tenant: different company entirely', target: 'someone@totally-different-domain.com', expectAllowed: false },
  { label: 'same domain, different user', target: 'alex@storefuze.com', expectAllowed: true },
  { label: 'same domain, same user (self)', target: 'zara@storefuze.com', expectAllowed: true },
  { label: 'case/whitespace should not matter', target: '  Zara@StoreFuze.com  ', expectAllowed: true },
  { label: 'malformed email', target: 'not-an-email', expectAllowed: false },
  { label: 'lookalike domain (subdomain trick)', target: 'someone@storefuze.com.evil.com', expectAllowed: false },
];

let failures = 0;
console.log(`own domain extracted from "${G_EMAIL}": ${ownDomain}\n`);
for (const c of cases) {
  const got = ownDomain ? impersonationAllowed(c.target, [ownDomain]) : false;
  const ok = got === c.expectAllowed;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.label.padEnd(40)} target="${c.target}" expected=${c.expectAllowed} got=${got}`);
}
console.log(`\n${cases.length - failures}/${cases.length} passed`);
process.exit(failures ? 1 : 0);
