/**
 * Prove the memory WRITE path end to end: create → list → delete.
 *
 * Listing memories returning 200 only proves the surface exists. What decides whether
 * Copilot memory can be migrated is whether we can put a fact in and read it back under
 * the same scope the agent will query at inference.
 *
 * Writes to OUR OWN project against a test engine, with a synthetic fact (no customer
 * data), and deletes what it creates.
 *
 * npx tsx src/spikes/_test_memory_write.ts [reasoningEngineId]
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const ENGINE = process.argv[2] ?? '7686282818770436096';
const PROJECT = process.env.GEMINI_PROJECT_FALLBACK ?? 'studio-enterprise-migration';
const LOCATION = 'us-central1';
const BASE = `https://${LOCATION}-aiplatform.googleapis.com/v1beta1/projects/${PROJECT}/locations/${LOCATION}/reasoningEngines/${ENGINE}`;

const token = await getSaToken();
const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

async function call(method: string, url: string, body?: unknown): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(url, { method, headers: auth, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
  return { status: res.status, json, text };
}

// A synthetic fact in the same subject/predicate/object shape Copilot's
// `intelligentmemory` uses, so this tests the real mapping, not a toy string.
const FACT = 'The user prefers weekly summaries delivered on Monday mornings.';
const SCOPE = { user_id: 'migration-probe-user' };

console.log('1. CREATE');
const created = await call('POST', `${BASE}/memories`, { fact: FACT, scope: SCOPE });
console.log(`   -> ${created.status} ${created.text.slice(0, 260).replace(/\s+/g, ' ')}`);

// Creation is a long-running operation; poll it so "created" means created.
let memoryName: string | undefined;
if (created.json?.name && String(created.json.name).includes('/operations/')) {
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const op = await call('GET', `https://${LOCATION}-aiplatform.googleapis.com/v1beta1/${created.json.name}`);
    if (op.json?.done) {
      memoryName = op.json?.response?.name;
      console.log(`   operation done -> ${memoryName ?? JSON.stringify(op.json).slice(0, 200)}`);
      break;
    }
  }
} else {
  memoryName = created.json?.name;
}

console.log('\n2. LIST');
const listed = await call('GET', `${BASE}/memories`);
const memories: Array<{ name: string; fact?: string }> = listed.json?.memories ?? [];
console.log(`   -> ${listed.status}  ${memories.length} memory(ies)`);
for (const m of memories) console.log(`      ${m.name.split('/').pop()}  fact="${(m.fact ?? '').slice(0, 60)}"`);

console.log('\n3. RETRIEVE (what the agent would do at inference)');
const retrieved = await call('POST', `${BASE}/memories:retrieve`, { scope: SCOPE });
console.log(`   -> ${retrieved.status} ${retrieved.text.slice(0, 300).replace(/\s+/g, ' ')}`);

console.log('\n4. DELETE (leave nothing behind)');
for (const m of memories) {
  const del = await call('DELETE', `https://${LOCATION}-aiplatform.googleapis.com/v1beta1/${m.name}`);
  console.log(`   ${m.name.split('/').pop()} -> ${del.status}`);
}

process.exit(0);
