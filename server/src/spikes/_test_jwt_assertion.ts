/**
 * Throwaway probe: does getGoogleAccessToken() (hand-built JWT assertion) mint a
 * usable DWD token, and does the allowlist still fail closed?
 *
 * Run: npx tsx src/spikes/_test_jwt_assertion.ts <adminEmail>
 */
import { getGoogleAccessToken, getSaToken } from '../auth/google.js';

const target = process.argv[2] ?? 'admin@migrationn.com';

const bad = await getGoogleAccessToken('not-an-email').catch((e) => `THREW: ${(e as Error).message}`);
console.log('malformed target ->', bad);

const out = await getGoogleAccessToken(target);
if (!out) {
  console.log('RESULT: null (exchange failed - see the warn line above for Google\'s reason)');
} else {
  console.log('RESULT: token minted, length', out.accessToken.length, 'expiresAt', out.expiresAt.toISOString());
  // Prove the token is real AND carries the impersonated identity, not the SA's.
  // tokeninfo, NOT userinfo: SA_SCOPES is cloud-platform, which cannot call userinfo.
  // tokeninfo needs no scope and reports back the granted scopes + the identity the
  // token actually carries, which is the thing under test.
  const ti = await fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(out.accessToken));
  console.log('tokeninfo', ti.status, (await ti.text()).slice(0, 400));
}

const viaLibrary = await getSaToken(target).then(() => 'ok').catch((e) => `failed: ${(e as Error).message}`);
console.log('library path for comparison ->', viaLibrary);
