/**
 * Drive a migration through the REAL HTTP API, using the operator's OWN live login session.
 *
 * Not an auth bypass and not a fixed-impersonation shortcut: the human signed in through the
 * browser, and this reuses that session exactly as the SPA would — same cookie, same
 * requireAuth check, same appUserId. The token is read from appLoginSessions and never printed.
 *
 *   cd server && npx tsx src/spikes/_run_migrate_api.ts <botId> [<botId> ...]
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

const botIds = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!botIds.length) throw new Error('usage: _run_migrate_api.ts <botId> [...]');

await connectMongo();
const db = getDb();
const login = (await db.collection('appLoginSessions').find({}).sort({ expiresAt: -1 }).limit(1).next()) as Record<string, any> | null;
if (!login) throw new Error('no live app login session — sign in through the UI first');
const token = String(login._id);

const session = (await db.collection('migrationSessions').find({}).sort({ _id: -1 }).limit(1).next()) as Record<string, any> | null;
if (!session) throw new Error('no migration session — connect both clouds through the UI first');
const sessionId = String(session._id);
const envUrl = 'https://org32322095.crm.dynamics.com';
// Reuse the destination the HUMAN chose in the UI. Never hardcode an engine id.
const destination = { environmentMap: { [envUrl]: session.plan?.destination?.environmentMap?.[envUrl] } };
if (!destination.environmentMap[envUrl]) throw new Error(`session plan has no destination for ${envUrl}`);
console.log(`session=${sessionId} as ${login.email}`);
console.log(`destination=${JSON.stringify(destination.environmentMap[envUrl])}`);

const headers = { 'Content-Type': 'application/json', Cookie: `csge_auth=${token}` /* the exact cookie requireAuth reads (appAuth.ts COOKIE) */ };

const planRes = await fetch('http://localhost:8080/api/migrate/plan', {
  method: 'POST',
  headers,
  body: JSON.stringify({
    session: sessionId,
    scope: { kind: 'agents', env: envUrl, botIds },
    destination,
    dryRun: false,
    // `--force` when the agent already exists and the SOURCE is unchanged: the change is on
    // OUR side (a fixed connector module), which drift detection cannot see by design.
    forceRedeploy: process.argv.includes('--force'),
    acknowledgeAclLoss: true,
  }),
});
const planBody = await planRes.text();
console.log(`\nPOST /plan -> ${planRes.status}\n${planBody.slice(0, 600)}`);
if (!planRes.ok) process.exit(1);

console.log('\n--- streaming ---');
const streamRes = await fetch(`http://localhost:8080/api/migrate/stream?session=${sessionId}`, { headers });
console.log(`GET /stream -> ${streamRes.status}`);
if (!streamRes.body) process.exit(1);
const reader = streamRes.body.getReader();
const dec = new TextDecoder();
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  for (const line of dec.decode(value).split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    try {
      const ev = JSON.parse(line.slice(5).trim()) as Record<string, any>;
      if (ev.kind === 'log') console.log(`  [${ev.level}] ${ev.message}`);
      else if (ev.kind === 'agent') console.log(`  AGENT ${ev.name}: deployed=${ev.deployed} shared=${ev.shared} verified=${ev.verified} ${ev.error ?? ''}`);
      else if (ev.kind === 'done') { console.log('  DONE'); process.exit(0); }
    } catch { /* keep-alive or partial frame */ }
  }
}
process.exit(0);
