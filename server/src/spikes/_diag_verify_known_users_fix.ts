import 'dotenv/config';
import { buildOrganizationProfile } from '../services/organizationProfile.js';
import { suggestMappings } from '../services/identityMap.js';
import type { Session } from '../sessionStore.js';

async function main() {
  const fakeSession = { gEmail: 'zara@storefuze.com' } as Session;
  const profile = await buildOrganizationProfile(fakeSession, new Date().toISOString());
  console.log('ownedDomains:', profile.ownedDomains);
  console.log('verifiedUserEmails count:', profile.google.verifiedUserEmails.length);
  console.log('sample:', profile.google.verifiedUserEmails.slice(0, 5));

  const fakePrincipals = [
    { type: 'user' as const, id: '1', email: 'zara@storefuze.com', displayName: 'Zara' }, // real
    { type: 'user' as const, id: '2', email: 'totally-made-up-name@storefuze.com', displayName: 'Fake' }, // fake, same domain
    { type: 'user' as const, id: '3', email: 'austin@fuzebot.co', displayName: 'Austin' }, // real
  ];
  const suggested = suggestMappings(fakePrincipals, profile.ownedDomains, { users: {}, groups: {} }, profile.google.verifiedUserEmails);
  console.log('suggested.users:', suggested.users);
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
