/**
 * Read-only: dump every stored knowledgeSourceCandidates entry from the most
 * recent migrationResults docs, so we can find a real source name whose
 * Graph search already returned exactly ONE plausible candidate (a genuine
 * unique-filename case) to use as a live end-to-end test.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  const results = await getDb().collection('migrationResults').find({}).sort({ $natural: -1 }).limit(30).toArray();
  console.log(`Found ${results.length} migrationResults docs`);
  for (const r of results as any[]) {
    if (r.knowledgeSourceCandidates?.length) {
      console.log(`--- agentId=${r.agentId ?? r._id} ---`);
      for (const c of r.knowledgeSourceCandidates) {
        console.log(`  source="${c.sourceName}" scopedToUser=${c.scopedToUser} candidates=${c.candidates?.length ?? 0}`);
        for (const cand of c.candidates ?? []) {
          console.log(`      - ${cand.name} (${cand.sizeBytes}b) in "${cand.parentContext}")`);
        }
      }
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
