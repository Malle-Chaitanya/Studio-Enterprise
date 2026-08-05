// Reports the current agent-creation quota status using the project's own
// quota.ts logic (no new mechanism) — reads AGENT_CREATE_DAILY_CAP and counts
// today's creates from migrationResults.
//   npx tsx src/spikes/_diag_check_agent_quota.ts
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { configuredDailyCap, countCreatesToday, currentQuotaDayStartUtc, nextQuotaResetUtc } from '../services/quota.js';

const PROJECT = '231705905417';

async function main() {
  await connectMongo();
  const cap = configuredDailyCap();
  const usedToday = await countCreatesToday(PROJECT);
  const dayStart = currentQuotaDayStartUtc();
  const nextReset = nextQuotaResetUtc();

  console.log('AGENT_CREATE_DAILY_CAP env:', process.env.AGENT_CREATE_DAILY_CAP || '(unset)');
  console.log('Configured cap:', cap ?? 'unknown (not set)');
  console.log('Current quota day started (UTC):', dayStart.toISOString());
  console.log('Next reset (UTC):', nextReset.toISOString());
  console.log('Agents created so far in this quota day (best-effort, from migrationResults):', usedToday);
  if (cap != null) {
    console.log('Remaining (estimate):', Math.max(0, cap - usedToday), '/', cap);
  } else {
    console.log('Remaining: unknown — no configured cap. This project\'s real Google-side limit is undocumented');
    console.log('and not exposed via any API (see quota.ts header comment) — only discoverable by hitting a 429.');
  }
}
main().catch((e) => console.error('FAILED:', e.message));
