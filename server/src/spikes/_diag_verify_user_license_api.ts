import 'dotenv/config';
import { checkUserLicense, assignUserLicense } from '../services/gemini.js';
import { getSaToken } from '../auth/google.js';
import type { GeminiDestination } from '../types.js';

/**
 * Verifies (or refutes) the one unconfirmed assumption in services/gemini.ts's
 * license-check functions: that the userStore id is `default_user_store` at
 * `projects/{project}/locations/global/userStores/{userStore}`. Run this
 * against a real tenant BEFORE relying on ensureAgentAccess's license step in
 * production — see the userStoreBase() doc comment in gemini.ts and
 * .claude/memory/decisions.md, 2026-08-12.
 *
 * Usage: npx tsx src/spikes/_diag_verify_user_license_api.ts
 */
async function main() {
  const dest: GeminiDestination = {
    project: '231705905417',
    engine: 'gemini-enterprise-17847887_1784788734248',
    assistant: 'default_assistant',
  };
  const saToken = await getSaToken();

  // A principal already known (this session's own live testing) to hold a
  // real, assigned Gemini Enterprise license.
  const licensedEmail = 'austin@fuzebot.co';
  // A principal known to hold NO license at all in this project.
  const unlicensedEmail = 'mia@filefuze.co';

  console.log('--- checkUserLicense(licensed) ---');
  console.log(await checkUserLicense(dest, saToken, licensedEmail));

  console.log('--- checkUserLicense(unlicensed) ---');
  console.log(await checkUserLicense(dest, saToken, unlicensedEmail));

  // Only exercise assignUserLicense if the read side above returned something
  // other than 'unknown' — if the GET already 404s, the store id is wrong and
  // there is no point spending a write call to confirm it twice.
  console.log('--- assignUserLicense(unlicensed) — comment out if the checks above returned "unknown" ---');
  console.log(await assignUserLicense(dest, saToken, unlicensedEmail));
}
main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
