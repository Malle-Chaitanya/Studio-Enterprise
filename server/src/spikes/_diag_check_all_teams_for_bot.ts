/** Checks whether MORE than one auto-generated access team already exists for Migrate
 *  Advisor (would settle "does each share/re-share spin up its own team, or do they
 *  accumulate members on one team" using real history, since we can't simulate an actual
 *  UI-driven re-share via the broken GrantAccess action). Also checks IsAuditEnabled on
 *  bot (already seen false earlier) to confirm there's no audit trail to fall back on.
 *   npx tsx src/spikes/_diag_check_all_teams_for_bot.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';

const BOT_ID_NO_DASHES = 'bdf9b8179b90f111b8da0022480b1f83';

async function dvGet(url: string, token: string, path: string) {
  const res = await fetch(`${url}/api/data/v9.2/${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  return { status: res.status, text: await res.text() };
}

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('no session');
  for (const env of s.environments ?? []) {
    if (env.name !== 'CloudFuze Agent Migration Hub') continue;
    const token = await clientCredsToken(s.tenantId ?? '', env.url);

    console.log('--- All teams whose name starts with this bot\'s GUID ---');
    const teams = await dvGet(env.url, token, `teams?$select=teamid,name,teamtype,createdon&$filter=startswith(name,'${BOT_ID_NO_DASHES}')`);
    console.log(teams.status, teams.text);
    process.exit(0);
  }
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
