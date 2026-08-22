import 'dotenv/config';
import { connectDb, getDb } from '../db/core.js';
import { config } from '../config.js';

const APP_USER_ID = '6a5dfdff7cf05623332758b7';

async function main() {
  await connectDb(config.CSGE_DB);
  const db = getDb(config.CSGE_DB);

  const sessions = await db
    .collection('migrationSessions')
    .find({ appUserId: APP_USER_ID })
    .sort({ createdAt: -1 })
    .limit(5)
    .toArray();

  console.log(`found ${sessions.length} session(s) for this appUserId`);
  for (const s of sessions) {
    // Report presence only — never the token values themselves.
    console.log(JSON.stringify({
      _id: s._id,
      step: s.step,
      createdAt: new Date(s.createdAt).toISOString(),
      hasDvToken: !!s.dvToken,
      hasRefreshToken: !!s.refreshToken,
      hasGToken: !!s.gToken,
      hasGRefreshToken: !!s.gRefreshToken,
      geminiProject: s.geminiProject,
      saOk: s.saOk,
      hasPlan: !!s.plan,
      planUnits: s.plan?.units?.length,
      planForceRedeploy: s.plan?.forceRedeploy,
      planDestination: s.plan?.destination,
    }, null, 2));
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
