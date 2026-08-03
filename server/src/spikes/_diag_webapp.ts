/**
 * Find the webapp URL (cid) for a project's Gemini Enterprise engine, so we can
 * deep-link the client straight to where their migrated agents actually appear
 * (instead of the generic business.gemini.google home / marketplace gallery).
 *
 *   npx tsx src/spikes/_diag_webapp.ts <projectNumber>
 *
 * READ-ONLY. Probes the widgetConfigs collection under the engine.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';

const HOST = 'https://discoveryengine.googleapis.com/v1alpha';
const PROJECT = process.argv[2];

async function tryGet(url: string, token: string) {
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.text();
    return { status: res.status, body };
  } catch (e) {
    return { status: 0, body: (e as Error).message };
  }
}

async function main() {
  if (!PROJECT) throw new Error('usage: npx tsx src/spikes/_diag_webapp.ts <projectNumber>');
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || s?.gEmail || undefined);
  const dest = await resolveDestination(PROJECT, token);
  console.log(`Project: ${PROJECT}  Engine: ${dest.engine}\n`);

  const base = `${HOST}/projects/${PROJECT}/locations/global/collections/default_collection`;
  const candidates = [
    `${base}/engines/${dest.engine}/widgetConfigs`,
    `${base}/widgetConfigs`,
    `${base}/engines/${dest.engine}`,
  ];

  for (const url of candidates) {
    const { status, body } = await tryGet(url, token);
    console.log(`GET ${url.replace(HOST, '')}\n  → ${status}`);
    if (status === 200) {
      // Surface any uiSettings / configId / name that looks like a widget cid.
      const cids = [...body.matchAll(/"(?:configId|uiSettings|name)"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
      const guids = [...body.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)].map((m) => m[0]);
      if (guids.length) console.log(`  possible cid(s): ${[...new Set(guids)].join(', ')}`);
      if (cids.length) console.log(`  fields: ${cids.slice(0, 6).join(' | ')}`);
      console.log(`  raw: ${body.replace(/\s+/g, ' ').slice(0, 500)}`);
    } else {
      console.log(`  ${body.replace(/\s+/g, ' ').slice(0, 200)}`);
    }
    console.log('');
  }
  process.exit(0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
