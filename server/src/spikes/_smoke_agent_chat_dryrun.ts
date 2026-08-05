/**
 * Smoke: chat-driven navigate + dry-run confirm path (rule-based, no LLM).
 * Run: npx tsx src/spikes/_smoke_agent_chat_dryrun.ts
 */
import { runAgentTurn } from '../agent/agentLoop.js';
import type { Session } from '../sessionStore.js';

const session: Session = {
  step: 'map-users',
  createdAt: Date.now(),
  tenantId: 'smoke-tenant',
  gEmail: 'admin@example.com',
};

async function collect(message: string, extra?: Partial<Parameters<typeof runAgentTurn>[0]>) {
  const events: Record<string, unknown>[] = [];
  await runAgentTurn(
    {
      sessionId: 'smoke-session',
      session,
      message,
      step: 'map-users',
      pathname: '/map-users',
      clientState: { userMap: { 'a@contoso.com': '' }, agents: [], envs: [] },
      ...extra,
    },
    (e) => events.push(e),
  );
  return events;
}

async function main() {
  const nav = await collect('Go to environments');
  const navEv = nav.find((e) => e.type === 'ui_event') as { event?: { type?: string; step?: string } } | undefined;
  if (navEv?.event?.type !== 'navigate_to_step' || navEv.event.step !== 'map') {
    throw new Error(`navigate failed: ${JSON.stringify(nav)}`);
  }
  console.log('ok navigate_to_step → map');

  const dry = await collect('Start dry run');
  const confirm = dry.find((e) => e.type === 'ui_event') as {
    event?: { type?: string; tool?: string; args?: { dryRun?: boolean } };
  } | undefined;
  if (confirm?.event?.type !== 'confirm_required' || confirm.event.tool !== 'start_migration') {
    throw new Error(`confirm_required missing: ${JSON.stringify(dry)}`);
  }
  if (confirm.event.args?.dryRun !== true) {
    throw new Error(`expected dryRun true: ${JSON.stringify(confirm)}`);
  }
  console.log('ok start_migration confirm_required (dry)');

  const go = await collect('yes, proceed', {
    confirmed: true,
    confirmTool: 'start_migration',
    confirmArgs: { dryRun: true },
    pathname: '/migrate',
    step: 'migrate',
  });
  const start = go.filter((e) => e.type === 'ui_event') as { event?: { type?: string; dryRun?: boolean } }[];
  const started = start.some((e) => e.event?.type === 'start_migration' && e.event.dryRun === true);
  if (!started) throw new Error(`start_migration ui_event missing: ${JSON.stringify(go)}`);
  console.log('ok confirmed dry run → start_migration ui_event');

  console.log('SMOKE PASS: chat-driven dry run path');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
