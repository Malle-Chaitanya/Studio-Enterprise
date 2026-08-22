/**
 * Where does "the daily API usage and limits for a HubSpot account" actually live?
 *
 * 10 staged agents call GetTheDailyApiUsageAndLimitsForAHubspotAccount, and the endpoint the
 * name implies (account-info/v3/api-usage/daily) returns 404 on this portal. An operation
 * with no working endpoint has to be declared lost rather than shipped as a tool that 404s
 * in front of a user, so every plausible candidate is probed before that call is made.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { getSaToken } from '../auth/google.js';
import { getEntraSecret } from '../services/secretManager.js';

await connectMongo();
const rec = (await getDb().collection('connectorCredentials').findOne({
  connectorId: { $in: ['shared_hubspotcrmv2', 'shared_hubspotcrm', 'shared_hubspotsettingsv2'] },
})) as { project?: string; secretIds?: Record<string, string> } | null;
const project = rec?.project ?? 'studio-enterprise-migration';
const got = await getEntraSecret(
  await getSaToken(),
  `projects/${project}/secrets/${Object.values(rec?.secretIds ?? {})[0]}/versions/latest`,
);
const token = (got.plaintext ?? '').trim();

for (const path of [
  '/account-info/v3/api-usage/daily',
  '/account-info/v1/api-usage/daily',
  '/integrations/v1/limit/daily',
  '/integrations/v1/usage/daily',
  '/account-info/v3/api-usage',
  '/account-info/v3/details',
  '/account-info/v3/usage-limits',
  // The real one, per HubSpot's docs: usage is reported PER PRIVATE APP, not per portal,
  // which is why every portal-level path above 404s.
  '/account-info/v3/api-usage/daily/private-apps',
]) {
  try {
    const res = await fetch(`https://api.hubapi.com${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    const body = (await res.text()).replace(/\s+/g, ' ');
    console.log(`${String(res.status).padEnd(4)} ${path.padEnd(46)} ${body.slice(0, 130)}`);
    // Every HubSpot response carries the remaining daily quota in a header. If the endpoint
    // above is unavailable on some portal, this is a real second source for the same
    // question rather than a guess.
    const rem = res.headers.get('x-hubspot-ratelimit-daily-remaining');
    const lim = res.headers.get('x-hubspot-ratelimit-daily');
    if (rem || lim) console.log(`     headers: daily=${lim} remaining=${rem}`);
  } catch (e) {
    console.log(`ERR  ${path.padEnd(38)} ${(e as Error).message.slice(0, 80)}`);
  }
}
process.exit(0);
