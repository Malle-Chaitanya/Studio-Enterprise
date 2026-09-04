import { getDb, connectDb } from '../db/core.js';
import { config } from '../config.js';
await connectDb(config.CSGE_DB);
const db = getDb(config.CSGE_DB);
for (const c of ['agentIRCache','stagedAgents','migrationResults','migrationLogs']) {
  const n = await db.collection(c).countDocuments({ $text: undefined } as any).catch(()=>0);
  const hit = await db.collection(c).find({}).limit(500).toArray();
  for (const d of hit as any[]) {
    const s = JSON.stringify(d);
    if (/getclientprofile/i.test(s)) {
      const m = s.match(/.{140}[Gg]et[Cc]lient[Pp]rofile.{140}/);
      console.log(`${c}: ${m?.[0]}`);
      break;
    }
  }
}
process.exit(0);
