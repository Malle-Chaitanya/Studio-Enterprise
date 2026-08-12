/**
 * Can the DESTINATION hold memory at all?
 *
 * Vertex AI Agent Engine exposes a Memory Bank on a reasoningEngine
 * (`.../reasoningEngines/{id}/memories`). Our migrated agents already ARE reasoning
 * engines, so if this is reachable with the service account we have, memory has a home.
 * If it is not, "save the memory" has nowhere to land and the answer changes.
 *
 * Read-only: LISTs only. Never prints memory content.
 *
 * npx tsx src/spikes/_probe_memory_bank.ts [reasoningEngineId]
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const ENGINE = process.argv[2] ?? '7686282818770436096';
const PROJECT = process.env.GEMINI_PROJECT_FALLBACK ?? 'studio-enterprise-migration';
const LOCATION = 'us-central1';

const token = await getSaToken();

async function probe(label: string, url: string): Promise<void> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.text();
  console.log(`\n── ${label}`);
  console.log(`   ${url.replace(PROJECT, '<project>')}`);
  console.log(`   -> ${res.status} ${body.slice(0, 300).replace(/\s+/g, ' ')}`);
}

const base = `https://${LOCATION}-aiplatform.googleapis.com`;

// 1. Does the engine exist and is the SA allowed to read it?
await probe('reasoningEngine', `${base}/v1beta1/projects/${PROJECT}/locations/${LOCATION}/reasoningEngines/${ENGINE}`);

// 2. The Memory Bank itself.
await probe('memories (v1beta1)', `${base}/v1beta1/projects/${PROJECT}/locations/${LOCATION}/reasoningEngines/${ENGINE}/memories`);
await probe('memories (v1)', `${base}/v1/projects/${PROJECT}/locations/${LOCATION}/reasoningEngines/${ENGINE}/memories`);

// 3. Sessions — memory generation reads from these.
await probe('sessions (v1beta1)', `${base}/v1beta1/projects/${PROJECT}/locations/${LOCATION}/reasoningEngines/${ENGINE}/sessions`);

process.exit(0);
