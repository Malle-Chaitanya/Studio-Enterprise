/**
 * Attempt a minimal agent create against a project and print the FULL raw
 * response — so we see the EXACT quota message (rate-limit vs hard cap) and any
 * Retry-After / quota-metric hints. Creates a throwaway agent; deletes it if it
 * somehow succeeds. READ-ONLY in effect on failure.
 *
 *   npx tsx src/spikes/_diag_quota.ts <projectNumber>
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { resolveDestination, assistantBase } from '../services/gemini.js';

const PROJECT = process.argv[2];

async function main() {
  if (!PROJECT) throw new Error('usage: npx tsx src/spikes/_diag_quota.ts <projectNumber>');
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const impersonate = process.env.GOOGLE_IMPERSONATE_EMAIL || s?.gEmail || undefined;
  console.log(`Project: ${PROJECT}   impersonating: ${impersonate ?? '(SA direct)'}`);

  const token = await getSaToken(impersonate);
  const dest = await resolveDestination(PROJECT, token);
  console.log(`Engine: ${dest.engine}\n`);

  const body = {
    displayName: '__cf_quota_probe__',
    description: 'temporary quota probe — safe to delete',
    lowCodeAgentDefinition: {
      rootAgentId: 'root_agent',
      nodes: [{ id: 'root_agent', displayName: 'probe', llmAgentNode: { description: 'probe', model: 'gemini-2.0-flash', instruction: 'probe', subAgentIds: [], selectedTools: { tool: [] } } }],
      draftDisplayName: 'probe', draftDescription: 'probe', draftStarterPrompts: [], draftIcon: { content: '' },
      deployedNodes: [], agentFiles: [], draftSchedules: [], deployedSchedules: [],
    },
  };

  const res = await fetch(`${assistantBase(dest)}/agents`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log(`HTTP ${res.status}`);
  console.log(`retry-after: ${res.headers.get('retry-after') ?? '(none)'}`);
  console.log('--- FULL RESPONSE BODY ---');
  console.log(text);

  if (res.ok) {
    const id = (JSON.parse(text) as { name?: string }).name?.split('/').pop();
    if (id) {
      const del = await fetch(`${assistantBase(dest)}/agents/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      console.log(`\n(probe agent created + cleaned up: delete ${del.status})`);
    }
  }
  process.exit(0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
