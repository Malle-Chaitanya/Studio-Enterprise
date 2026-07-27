import { nextQuotaResetUtc, currentQuotaDayStartUtc, preflightQuota } from './services/quota.js';
const t = (iso: string) => new Date(iso);
async function main() {
  console.log('=== reset math ===');
  for (const s of ['2026-07-26T20:27:00Z', '2026-07-27T07:59:00Z', '2026-07-27T08:00:00Z', '2026-07-27T09:00:00Z']) {
    console.log(s, '-> next reset', nextQuotaResetUtc(t(s)).toISOString(), '| day start', currentQuotaDayStartUtc(t(s)).toISOString());
  }
  console.log('=== preflight cap UNSET ===');
  console.log(' ', (await preflightQuota('p', 35, t('2026-07-26T20:27:00Z'))).message);
  process.env.AGENT_CREATE_DAILY_CAP = '50';
  console.log('=== cap=50, req 35 ===');
  console.log(' ', (await preflightQuota('p', 35, t('2026-07-26T20:27:00Z'))).message);
  process.env.AGENT_CREATE_DAILY_CAP = '20';
  console.log('=== cap=20, req 35 (overflow) ===');
  const r = await preflightQuota('p', 35, t('2026-07-26T20:27:00Z'));
  console.log(' ', r.message);
  console.log('  fitsNow=', r.fitsNow, 'overflow=', r.overflow, 'willFit=', r.willFit);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
