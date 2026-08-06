/**
 * Deploy a v9 RE using AdkApp DIRECTLY (no ReasoningEngineAgentWrapper).
 * Hypothesis: RE runtime has special-case handling for AdkApp class that
 * exposes 'query' as an available method, unlike our standalone wrapper
 * which only gets stream_query / async_stream_query via *_query suffix filter.
 *
 * Two-step test:
 *   1. Deploy minimal AdkApp-backed RE
 *   2. Warm it up
 *   3. Call class_method=query — if 200, register as Agentspace agent
 *   4. If 400, confirm dead-end and clean up
 *
 * Run: cd server && npx tsx src/spikes/_deploy_v9_adkapp.ts
 * NOTE: Deploy takes 5-10 minutes.
 */
import 'dotenv/config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';
import path from 'path';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SA_PROJECT = 'studio-enterprise-migration';
const SA_PROJECT_NUM = '231705905417';
const GEMINI_ADMIN = 'mia@cloudfuze.com';
const GCP_PROJECT_CUSTOMER = 'sonorous-lightning-t224x';
const LOCATION = 'us-central1';
const BUCKET = `gs://${SA_PROJECT}-adk-staging`;
const HOST_AI = `https://${LOCATION}-aiplatform.googleapis.com/v1beta1`;

// Use the existing Confluence data store (already has pages)
const DATA_STORE = `projects/${SA_PROJECT}/locations/global/collections/default_collection/dataStores/cf-knowledge-eng-hr`;

// Write a temporary adk_deploy script that uses AdkApp directly
const V9_SCRIPT = String.raw`#!/usr/bin/env python
"""Deploy v9 RE: AdkApp directly, no wrapper. Test if 'query' becomes available."""
import argparse
import json
import os

def emit(obj):
    print(json.dumps(obj), flush=True)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", required=True)
    ap.add_argument("--location", default="us-central1")
    ap.add_argument("--staging-bucket", required=True)
    ap.add_argument("--data-store", required=True)
    args = ap.parse_args()

    key = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS") or os.environ.get("GOOGLE_SA_KEY_FILE")
    if key and not os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"):
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = key

    try:
        import vertexai
        from vertexai import agent_engines
        from vertexai.preview.reasoning_engines import AdkApp
        from google.adk.agents import Agent
        from google.adk.tools import VertexAiSearchTool
    except Exception as e:
        emit({"error": f"import failed: {e}"}); return

    try:
        search_tool = VertexAiSearchTool(data_store_id=args.data_store)
        root_agent = Agent(
            name="confluence_knowledge_v9",
            model="gemini-2.5-flash",
            description="Confluence knowledge agent v9 (AdkApp direct)",
            instruction="You are a helpful assistant. Use the knowledge tool to find accurate answers. Always cite sources.",
            tools=[search_tool],
        )
    except Exception as e:
        emit({"error": f"agent build failed: {e}"}); return

    try:
        # KEY DIFFERENCE: use AdkApp directly, not ReasoningEngineAgentWrapper
        app = AdkApp(agent=root_agent, enable_tracing=False)
        vertexai.init(project=args.project, location=args.location, staging_bucket=args.staging_bucket)
        remote = agent_engines.create(
            agent_engine=app,
            display_name="Confluence Knowledge Agent v9 (AdkApp)",
            requirements=["google-cloud-aiplatform[agent_engines,adk]", "google-adk"],
        )
        emit({"reasoningEngine": remote.resource_name})
    except Exception as e:
        emit({"error": f"deploy failed: {e}"})

if __name__ == "__main__":
    main()
`;

// Write v9 deploy script to temp location
import { writeFileSync } from 'fs';
const v9ScriptPath = path.join(__dirname, '..', '..', 'scripts', '_v9_adkapp_deploy.py');
writeFileSync(v9ScriptPath, V9_SCRIPT, { encoding: 'utf8' });
console.log(`[0] v9 script written to ${v9ScriptPath}`);

// Deploy v9 RE
console.log('\n[1] Deploying v9 RE with AdkApp directly (5-10 min)...');
const env = { ...process.env };
const { stdout, stderr } = await execFileAsync('python', [
  v9ScriptPath,
  '--project', SA_PROJECT,
  '--location', LOCATION,
  '--staging-bucket', BUCKET,
  '--data-store', DATA_STORE,
], { timeout: 15 * 60 * 1000, env });

if (stderr) console.log(`  stderr: ${stderr.slice(0, 300)}`);
const lines = stdout.trim().split('\n');
const last = lines[lines.length - 1];
console.log(`  deploy output: ${last}`);

const out = JSON.parse(last) as { reasoningEngine?: string; error?: string };
if (out.error) {
  console.error(`\n❌ DEPLOY FAILED: ${out.error}`);
  process.exit(1);
}

const reFullName = out.reasoningEngine!;
const reId = reFullName.split('/').pop()!;
const RE_PATH = `projects/${SA_PROJECT_NUM}/locations/${LOCATION}/reasoningEngines/${reId}`;
console.log(`\n✅ v9 RE deployed: ${reFullName}`);

// Get SA token for RE calls
const saToken = await getSaToken();

// Warm up (retry loop, up to 3 min)
console.log('\n[2] Warming up v9 RE (up to 3 min)...');
let warmed = false;
for (let i = 0; i < 6; i++) {
  console.log(`  Attempt ${i + 1}/6...`);
  const wr = await fetch(`${HOST_AI}/${RE_PATH}:streamQuery`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ class_method: 'stream_query', input: { user_id: 'v9-warmup', message: 'ping' } }),
  });
  if (wr.ok) { warmed = true; console.log(`  ✅ RE warm (${wr.status})`); break; }
  const wt = await wr.text();
  if (wr.status === 400) { warmed = true; console.log(`  RE running (400 = method issue, but container up)`); break; }
  console.log(`  ${wr.status}: ${wt.slice(0, 100)} — waiting 30s`);
  await new Promise(r => setTimeout(r, 30000));
}

if (!warmed) {
  console.log('\n❌ RE did not warm in 3 min. Check logs later.');
  process.exit(1);
}

// Test class_method=query
console.log('\n[3] Testing class_method=query on v9 RE...');
const qr = await fetch(`${HOST_AI}/${RE_PATH}:streamQuery`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    class_method: 'query',
    input: { user_id: 'v9-query-test', message: 'What is the sick leave policy?' },
  }),
});
const qt = await qr.text();
console.log(`  query status: ${qr.status}`);

if (qr.ok) {
  console.log('\n✅✅✅ class_method=query WORKS with AdkApp direct!');
  // Extract answer text
  const answer = qt.split('\n')
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
    .filter(Boolean)
    .flatMap(j => ((j!['content'] as Record<string, unknown>)?.['parts'] as Array<Record<string, unknown>> ?? []).map(p => p['text'] as string))
    .filter(Boolean)
    .join('')
    .slice(0, 300);
  console.log(`  Answer: ${answer}`);

  // Register as Agentspace agent
  console.log('\n[4] Registering v9 RE as Agentspace agent...');
  const miaToken = await getSaToken(GEMINI_ADMIN);
  const dest = await resolveDestination(GCP_PROJECT_CUSTOMER, miaToken);
  const agentBase = `https://discoveryengine.googleapis.com/v1alpha/projects/${dest.project}/locations/global/collections/default_collection/engines/${dest.engine}/assistants/${dest.assistant}/agents`;
  const ar = await fetch(agentBase, {
    method: 'POST',
    headers: { Authorization: `Bearer ${miaToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      displayName: 'Confluence Knowledge Agent v9',
      description: 'Confluence ENG+HR knowledge — migrated by Studio Migrate',
      adkAgentDefinition: {
        provisionedReasoningEngine: { reasoningEngine: reFullName },
      },
    }),
  });
  const aj = await ar.json() as Record<string, unknown>;
  console.log(`  Agent state: ${aj['state']}, ID: ${String(aj['name']).split('/').pop()}`);

  // Share with all users
  if (aj['state'] === 'ENABLED') {
    const agentId = String(aj['name']).split('/').pop();
    await fetch(`${agentBase}/${agentId}?updateMask=sharingConfig`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${miaToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sharingConfig: { scope: 'ALL_USERS' } }),
    });
    console.log(`\n  ✅ Agent shared! Test in business.gemini.google → "Confluence Knowledge Agent v9"`);
  }
} else {
  console.log(`  Error: ${qt.slice(0, 400)}`);
  if (qt.includes('query') && qt.includes('not found')) {
    console.log('\n❌ AdkApp direct also fails with class_method=query.');
    console.log('   Platform limitation confirmed: RE runtime never exposes "query" method.');
    console.log('   Next steps: file Google support ticket or use alternative demo approach.');
  }
  console.log(`\n  v9 RE ID: ${reId} (in SA project, can delete or reuse for stream_query)`);
}
