/**
 * Verify raw landing against a REAL MongoDB — the half unit tests cannot reach.
 *
 * The unit suite mocks the driver, so it proves our logic and nothing about Mongo's:
 * whether `ensureCollections` actually created the collection, whether the TTL index
 * exists with `expireAfterSeconds: 0`, and whether the unique key really rejects a
 * duplicate. A TTL index that was never created is the dangerous failure here — every
 * write succeeds, every read works, and unredacted customer payloads simply never expire.
 * Nothing surfaces that except looking.
 *
 * Run:  cd server && npx tsx src/spikes/_test_raw_landing.ts
 *
 * Writes to a throwaway appUserId and deletes what it wrote. Safe against a dev database.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb, isDbConnected } from '../db/core.js';
import { config } from '../config.js';
import {
  saveRawAgent,
  listRawAgents,
  getRawAgent,
  rawLandingEnabled,
  type RawAgentDoc,
} from '../db/repos/rawAgents.js';

const TEST_USER = '__rawlanding_probe__';
const OTHER_USER = '__rawlanding_other__';
const RUN = 'probe-run-1';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  await connectMongo();
  if (!isDbConnected()) {
    console.error('Mongo is not connected. Start it, then re-run:');
    console.error('  docker run -d --name csge-mongodb --restart unless-stopped \\');
    console.error('    -p 127.0.0.1:27019:27017 -v csge-mongo-data:/data/db mongo:7.0');
    process.exit(1);
  }
  const db = getDb();

  // ── 1. Bootstrap created the collection and its indexes ────────────────────
  const collections = (await db.listCollections().toArray()).map((c) => c.name);
  check('rawAgents collection exists', collections.includes('rawAgents'));

  const indexes = await db.collection('rawAgents').indexes();
  const ttl = indexes.find((i) => i.key?.expiresAt === 1);
  check('TTL index on expiresAt exists', !!ttl);
  check(
    'TTL index expires at the stamped time (expireAfterSeconds: 0)',
    ttl?.expireAfterSeconds === 0,
    `got ${String(ttl?.expireAfterSeconds)}`,
  );

  const unique = indexes.find(
    (i) => i.key?.appUserId === 1 && i.key?.runId === 1 && i.key?.sourceId === 1,
  );
  check('unique index on (appUserId, runId, sourceId) exists', !!unique && unique.unique === true);

  // ── 2. The opt-in gate is what actually governs writes ─────────────────────
  console.log(`\nRAW_RETENTION_DAYS=${config.RAW_RETENTION_DAYS} (landing ${rawLandingEnabled() ? 'ON' : 'OFF'})`);
  if (!rawLandingEnabled()) {
    await saveRawAgent({
      appUserId: TEST_USER, runId: RUN, envUrl: 'https://probe.crm.dynamics.com',
      sourceId: 'bot-off', sourceName: 'Gate probe', components: [{ a: 1 }],
    });
    const off = await getRawAgent(TEST_USER, RUN, 'bot-off');
    check('opted out: nothing was written', off === null);
    console.log('\nSet RAW_RETENTION_DAYS=7 in server/.env and re-run to exercise the write path.');
    await cleanup(db);
    process.exit(failures ? 1 : 0);
  }

  // ── 3. Round trip ──────────────────────────────────────────────────────────
  const components = [
    { name: 'topic-a', componenttype: 0, data: '{"kind":"AdaptiveDialog"}' },
    { name: 'tool-b', componenttype: 15, data: '{"kind":"TaskDialog"}' },
  ];
  await saveRawAgent({
    appUserId: TEST_USER, runId: RUN, envUrl: 'https://probe.crm.dynamics.com',
    sourceId: 'bot-1', sourceName: 'Probe Agent',
    components, botRecord: { configuration: '{"settings":{}}' },
    disabledComponentNames: ['retired-topic'],
  });

  const got = await getRawAgent(TEST_USER, RUN, 'bot-1');
  check('row round-trips', !!got);
  check('components stored verbatim', JSON.stringify(got?.components) === JSON.stringify(components));
  check('botRecord stored', !!got?.botRecord);
  check('disabled component names stored', got?.disabledComponentNames?.[0] === 'retired-topic');
  check('totalComponents recorded', got?.totalComponents === 2);
  check('expiresAt is in the future', !!got && got.expiresAt.getTime() > Date.now());

  // ── 4. Idempotency: a re-run must replace, not accumulate ──────────────────
  await saveRawAgent({
    appUserId: TEST_USER, runId: RUN, envUrl: 'https://probe.crm.dynamics.com',
    sourceId: 'bot-1', sourceName: 'Probe Agent (re-run)', components: [{ name: 'only-one' }],
  });
  const after = await listRawAgents(TEST_USER, RUN);
  check('re-running the same run replaces the row', after.length === 1, `${after.length} row(s)`);
  check('replaced row holds the newer payload', after[0]?.totalComponents === 1);

  // ── 5. Tenant isolation ────────────────────────────────────────────────────
  await saveRawAgent({
    appUserId: OTHER_USER, runId: RUN, envUrl: 'https://other.crm.dynamics.com',
    sourceId: 'bot-1', sourceName: 'Other tenant agent', components: [{ secret: 'not yours' }],
  });
  const mine = await listRawAgents(TEST_USER, RUN);
  check('another tenant\'s row is not visible', mine.length === 1 && mine[0].appUserId === TEST_USER);
  const cross = await getRawAgent(TEST_USER, RUN, 'bot-1');
  check('cross-tenant read returns only our own row', cross?.envUrl === 'https://probe.crm.dynamics.com');

  await cleanup(db);
  console.log(`\n${failures ? `${failures} CHECK(S) FAILED` : 'ALL CHECKS PASSED'}`);
  process.exit(failures ? 1 : 0);
}

async function cleanup(db: ReturnType<typeof getDb>): Promise<void> {
  await db.collection<RawAgentDoc>('rawAgents').deleteMany({
    appUserId: { $in: [TEST_USER, OTHER_USER] },
  });
  console.log('\ncleaned up probe rows');
}

main().catch((e) => {
  console.error('PROBE FAILED:', (e as Error).message);
  process.exit(1);
});
