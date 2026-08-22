/**
 * What does HubSpot CMS `TemplatesList` actually call, and does this portal answer it?
 *
 * One agent uses shared_hubspotcms, which has no registry entry — so it is reported as an
 * unsupported connector and gets no tool at all. Before adding an entry, the endpoint has to
 * be measured: the Independent Publisher operation names do not match HubSpot's URLs (the
 * daily-usage operation needed five probes to locate), so guessing produces a tool that 404s
 * in front of a user.
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
  '/cms/v3/design-manager/templates',
  '/cms/v3/pages/site-pages',
  '/cms/v3/blogs/posts',
  '/content/api/v2/templates',
]) {
  try {
    const res = await fetch(`https://api.hubapi.com${path}?limit=3`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    const body = (await res.text()).replace(/\s+/g, ' ');
    console.log(`${String(res.status).padEnd(4)} ${path.padEnd(36)} ${body.slice(0, 600)}`);
  } catch (e) {
    console.log(`ERR  ${path.padEnd(36)} ${(e as Error).message.slice(0, 80)}`);
  }
}
process.exit(0);
