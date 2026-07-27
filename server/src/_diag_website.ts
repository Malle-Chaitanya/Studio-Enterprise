/**
 * Verify the WEBSITE knowledge path end-to-end against the real engine:
 *   create PUBLIC_WEBSITE data store → add the URL as a target site →
 *   attach the store to engine.dataStoreIds.
 *
 *   npx tsx src/_diag_website.ts "https://learn.microsoft.com/en-us/dynamics365"
 *
 * Creates a clearly-named test store (cf-web-test) so it's easy to identify and
 * remove. Reports each step. If all three succeed, the website path works and I
 * wire it into the migration (deriving the store id/URL from the source).
 */
import 'dotenv/config';
import { connectMongo } from './db/mongo.js';
import { getDb } from './db/core.js';
import type { Session } from './sessionStore.js';
import { getSaToken } from './auth/google.js';
import { defaultDestination } from './services/gemini.js';
import { createDataStore, addTargetSite, attachDataStoreToEngine } from './services/geminiDataStore.js';

const URL_ARG = process.argv[2] || 'https://learn.microsoft.com/en-us/dynamics365';

/** Turn a URL into a Discovery Engine target-site URI pattern. */
function toUriPattern(u: string): string {
  const stripped = u.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return `${stripped}/*`;
}

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s?.geminiProject) throw new Error('no session with a geminiProject');
  const saToken = await getSaToken(s.gEmail || undefined);
  const dest = defaultDestination(s.geminiProject);
  const dataStoreId = 'cf-web-adv';

  console.log(`URL: ${URL_ARG}\ndataStoreId: ${dataStoreId}\n`);

  console.log('1) create website data store…');
  const create = await createDataStore(dest.project, saToken, {
    dataStoreId,
    displayName: 'CF Web Test',
    kind: 'website',
  });
  console.log(`   ${create.created ? 'CREATED' : create.alreadyExists ? 'ALREADY EXISTS' : 'FAILED'}${create.error ? ` — ${create.error}` : ''}`);

  console.log('2) add target site (the URL)…');
  const site = await addTargetSite(dest.project, saToken, dataStoreId, toUriPattern(URL_ARG));
  console.log(`   ${site.ok ? 'ADDED ' + toUriPattern(URL_ARG) : 'FAILED — ' + site.error}`);

  console.log('3) attach data store to engine.dataStoreIds…');
  const attach = await attachDataStoreToEngine(dest, saToken, dataStoreId);
  console.log(`   ${attach.ok ? 'ATTACHED' : 'FAILED — ' + attach.error}`);
  if (attach.dataStoreIds) console.log(`   engine.dataStoreIds now: ${JSON.stringify(attach.dataStoreIds)}`);

  const allOk = (create.created || create.alreadyExists) && site.ok && attach.ok;
  console.log(`\n${allOk ? '✅ WEBSITE PATH WORKS' : '❌ a step failed — see above'}`);
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
