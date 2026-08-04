/**
 * Fetch the Discovery Engine v1alpha API discovery document and print the exact
 * request schema for the agent-file upload method (…/files:upload). This tells
 * us the correct body field names (the probe showed the endpoint exists but our
 * field names were wrong).
 *
 *   npx tsx src/spikes/_diag_discovery.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';

const DISCOVERY = 'https://discoveryengine.googleapis.com/$discovery/rest?version=v1alpha';

type Json = Record<string, unknown>;

/** Recursively collect every method object under resources.*. */
function collectMethods(node: Json, out: Json[]): void {
  const methods = node.methods as Record<string, Json> | undefined;
  if (methods) for (const m of Object.values(methods)) out.push(m);
  const resources = node.resources as Record<string, Json> | undefined;
  if (resources) for (const r of Object.values(resources)) collectMethods(r, out);
}

/** Print a schema's properties (one level), resolving $ref names. */
function printSchema(schemas: Record<string, Json>, ref: string | undefined, indent = '   '): void {
  if (!ref) return void console.log(`${indent}(no request body schema)`);
  const schema = schemas[ref];
  if (!schema) return void console.log(`${indent}(schema ${ref} not found)`);
  console.log(`${indent}schema ${ref}:`);
  const props = schema.properties as Record<string, Json> | undefined;
  if (!props) return void console.log(`${indent}  (no properties)`);
  for (const [name, def] of Object.entries(props)) {
    const t = (def.type as string) ?? (def.$ref as string) ?? '?';
    const fmt = def.format ? `/${def.format}` : '';
    console.log(`${indent}  ${name}: ${t}${fmt}${def.description ? ` — ${String(def.description).slice(0, 80)}` : ''}`);
  }
}

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const saToken = s?.gEmail ? await getSaToken(s.gEmail) : undefined;

  const res = await fetch(DISCOVERY, saToken ? { headers: { Authorization: `Bearer ${saToken}` } } : undefined);
  if (!res.ok) throw new Error(`discovery fetch failed (${res.status})`);
  const doc = (await res.json()) as Json;
  const schemas = (doc.schemas as Record<string, Json>) ?? {};

  const methods: Json[] = [];
  collectMethods(doc, methods);

  // Any method whose id/path involves agent files or uploading.
  const fileMethods = methods.filter((m) => /files/i.test(String(m.id)) || /files:/.test(String(m.path)) || /upload/i.test(String(m.id)));
  console.log(`\nFound ${fileMethods.length} candidate method(s):\n`);
  for (const m of fileMethods) {
    console.log('='.repeat(70));
    console.log(`id:     ${m.id}`);
    console.log(`http:   ${m.httpMethod} ${m.path}`);
    const req = m.request as Json | undefined;
    printSchema(schemas, req?.$ref as string | undefined);
    // Full method object — reveals mediaUpload protocols + the real upload path.
    console.log('\n   FULL METHOD JSON:');
    console.log(JSON.stringify(m, null, 2).split('\n').map((l) => '   ' + l).join('\n'));
    console.log('');
  }
  if (!fileMethods.length) console.log('(no file/upload methods found — the doc may not expose them)');
  process.exit(0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
