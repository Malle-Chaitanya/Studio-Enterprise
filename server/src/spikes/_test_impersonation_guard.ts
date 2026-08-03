/**
 * Guard test for DWD impersonation (security-critical).
 *
 * Asserts the service account can only ever be asked to impersonate a VALID
 * target, and — when an allowlist is configured — only accounts on it. Pure
 * function, no network. Run: `cd server && npx tsx src/_test_impersonation_guard.ts`
 */
import { impersonationAllowed, parseImpersonationAllowlist } from './auth/google.js';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`);
  }
}

// ── Malformed / empty targets are always refused (fail closed) ────────────────
console.log('malformed targets:');
for (const bad of ['', '  ', 'notanemail', 'no@domain', '@nolocal.com', 'a@b']) {
  check(`refuse "${bad}"`, impersonationAllowed(bad, []) === false);
  check(`refuse "${bad}" (with allowlist)`, impersonationAllowed(bad, ['@acme.com']) === false);
}

// ── No allowlist → any well-formed email allowed (multi-tenant SaaS mode) ──────
console.log('\nno allowlist (layer-1 only):');
check('allow valid email', impersonationAllowed('mia@cloudfuze.com', []) === true);
check('allow other tenant', impersonationAllowed('admin@othercorp.com', []) === true);

// ── Domain allowlist ──────────────────────────────────────────────────────────
console.log('\ndomain allowlist [@cloudfuze.com]:');
const domainList = parseImpersonationAllowlist('@cloudfuze.com , Cloudfuze.com'); // dedup-ish, mixed case
check('allow in-domain', impersonationAllowed('mia@cloudfuze.com', domainList) === true);
check('allow in-domain (case-insensitive)', impersonationAllowed('MIA@CloudFuze.com', domainList) === true);
check('refuse out-of-domain', impersonationAllowed('evil@attacker.com', domainList) === false);
check('refuse lookalike domain', impersonationAllowed('mia@cloudfuze.com.attacker.com', domainList) === false);

// ── Exact-email allowlist (the strictest "one designated account") ────────────
console.log('\nexact-account allowlist [gemini-migrations@acme.com]:');
const exact = parseImpersonationAllowlist('gemini-migrations@acme.com');
check('allow designated account', impersonationAllowed('gemini-migrations@acme.com', exact) === true);
check('refuse other account, same domain', impersonationAllowed('ceo@acme.com', exact) === false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
