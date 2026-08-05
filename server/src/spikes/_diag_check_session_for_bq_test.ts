import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  const s = await getDb()
    .collection('migrationSessions')
    .find({})
    .sort({ $natural: -1 })
    .limit(1)
    .next();
  if (!s) {
    console.log('NO_SESSION_FOUND');
    process.exit(0);
  }
  console.log(
    'SESSION_FOUND',
    JSON.stringify(
      {
        appUserId: s.appUserId,
        geminiProject: s.geminiProject,
        gEmail: s.gEmail,
        hasGoogleTokens: !!s.googleTokens,
        createdAt: s.createdAt,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
main().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
