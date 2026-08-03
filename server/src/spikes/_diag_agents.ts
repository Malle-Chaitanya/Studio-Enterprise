/**
 * List (and optionally delete) the agents occupying a project's agent-creation
 * quota. Use this to see WHY "Agent creation quota exceeded" is thrown — the
 * subscription is fine, the per-project agent SLOTS are just full — and to free
 * slots by deleting throwaway/test agents so a live run can create again.
 *
 *   npx tsx src/_diag_agents.ts <projectNumber>                 # list
 *   npx tsx src/_diag_agents.ts <projectNumber> delete <id>     # delete one
 *   npx tsx src/_diag_agents.ts <projectNumber> delete-matching "test"   # delete all whose displayName contains "test"
 *
 * Identity: uses GOOGLE_SA_KEY_FILE. Impersonates GOOGLE_IMPERSONATE_EMAIL if
 * set, else the last session's gEmail, else the SA directly. So point .env at
 * whichever project/subscription you want to clean, then run this.
 *
 * DELETE IS IRREVERSIBLE — it removes the agent from the Gemini app. Only pass
 * `delete`/`delete-matching` when you mean it; `list` (default) is read-only.
 */
import 'dotenv/config';
import { connectMongo } from './db/mongo.js';
import { getDb } from './db/core.js';
import type { Session } from './sessionStore.js';
import { getSaToken } from './auth/google.js';
import { resolveDestination, assistantBase } from './services/gemini.js';

const PROJECT = process.argv[2];
const ACTION = (process.argv[3] || 'list').toLowerCase(); // list | delete | delete-matching
const TARGET = process.argv[4] || '';

interface AgentRow { name: string; id: string; displayName?: string }

async function listAgents(base: string, token: string): Promise<AgentRow[]> {
  const rows: AgentRow[] = [];
  let pageToken: string | undefined;
  do {
    const url = `${base}/agents${pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const body = (await res.text()).replace(/\s+/g, ' ').slice(0, 300);
      throw new Error(`list agents → ${res.status}: ${body}`);
    }
    const json = (await res.json()) as { agents?: Record<string, unknown>[]; nextPageToken?: string };
    for (const a of json.agents ?? []) {
      const name = String(a.name);
      rows.push({ name, id: name.split('/').pop() ?? '', displayName: a.displayName as string | undefined });
    }
    pageToken = json.nextPageToken;
  } while (pageToken);
  return rows;
}

async function deleteAgent(base: string, token: string, id: string): Promise<boolean> {
  const res = await fetch(`${base}/agents/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.ok) return true;
  const body = (await res.text()).replace(/\s+/g, ' ').slice(0, 200);
  console.log(`   delete ${id} → ${res.status}: ${body}`);
  return false;
}

async function main() {
  if (!PROJECT) throw new Error('usage: npx tsx src/_diag_agents.ts <projectNumber> [list|delete <id>|delete-matching <substr>]');
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const impersonate = process.env.GOOGLE_IMPERSONATE_EMAIL || s?.gEmail || undefined;

  console.log(`Project: ${PROJECT}`);
  console.log(`Impersonating: ${impersonate ?? '(SA directly)'}`);

  const token = await getSaToken(impersonate);
  const dest = await resolveDestination(PROJECT, token);
  console.log(`Engine: ${dest.engine}  Assistant: ${dest.assistant}\n`);
  const base = assistantBase(dest);

  const agents = await listAgents(base, token);
  console.log(`${agents.length} agent(s) currently occupying quota:\n`);
  for (const a of agents) console.log(`  - ${a.id}   "${a.displayName ?? ''}"`);
  console.log('');

  if (ACTION === 'delete') {
    if (!TARGET) throw new Error('delete needs an agent id: ... delete <id>');
    console.log(`Deleting ${TARGET} …`);
    const ok = await deleteAgent(base, token, TARGET);
    console.log(ok ? '✅ deleted — one slot freed.' : '❌ delete failed (see above).');
  } else if (ACTION === 'delete-matching') {
    if (!TARGET) throw new Error('delete-matching needs a substring: ... delete-matching "test"');
    const victims = agents.filter((a) => (a.displayName ?? '').toLowerCase().includes(TARGET.toLowerCase()));
    console.log(`Deleting ${victims.length} agent(s) whose name contains "${TARGET}" …`);
    let freed = 0;
    for (const v of victims) {
      process.stdout.write(`  ${v.id} "${v.displayName}" … `);
      const ok = await deleteAgent(base, token, v.id);
      if (ok) { freed++; console.log('deleted'); }
    }
    console.log(`\n✅ freed ${freed} slot(s).`);
  } else {
    console.log('(read-only. To free a slot: ... delete <id>   or   ... delete-matching "test")');
  }
  process.exit(0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
