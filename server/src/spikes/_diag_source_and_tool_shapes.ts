/**
 * What SHAPES do knowledge sources and tools actually take in the tenant?
 *
 * Two questions this answers with data instead of intuition:
 *   1. Are knowledge sources scoped to sub-resources (specific Confluence spaces/pages,
 *      a specific SharePoint folder) or to whole systems? Scope is fidelity: migrating a
 *      one-folder source as a whole-site crawl changes what the agent knows.
 *   2. Do tools carry a model-facing DESCRIPTION from the source, and do they carry the
 *      inputs the author bound? The description is what makes a migrated tool selectable
 *      by the model; the bindings are what make the call identical.
 *
 * Read-only. npx tsx src/spikes/_diag_source_and_tool_shapes.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';

const ENVS = ['https://org32322095.crm.dynamics.com', 'https://orga243378d.crm.dynamics.com'];

await connectMongo();
const row = (await getDb().collection('environmentsCache').find({ tenantId: { $exists: true } })
  .sort({ $natural: -1 }).limit(1).next()) as { tenantId?: string } | null;
const tenant = row?.tenantId;
if (!tenant) { console.error('no cached tenant'); process.exit(1); }

async function all(env: string, token: string, path: string): Promise<any[]> {
  const out: any[] = [];
  let next: string | null = `${env}/api/data/v9.2/${path}`;
  while (next) {
    const res: Response = await fetch(next, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', Prefer: 'odata.maxpagesize=500' },
    });
    if (!res.ok) { console.log(`  ${res.status} on ${path}`); break; }
    const j = (await res.json()) as any;
    out.push(...(j.value ?? []));
    next = j['@odata.nextLink'] ?? null;
  }
  return out;
}

for (const env of ENVS) {
  const token = await clientCredsToken(tenant, env);
  console.log(`\n══════ ${env} ══════`);

  // ── knowledge sources (componenttype 16) ────────────────────────────────
  const ks = await all(env, token, "botcomponents?$select=name,data,content,description,schemaname&$filter=componenttype eq 16 and statecode eq 0");
  const kinds = new Map<string, number>();
  const scoped: string[] = [];
  for (const c of ks) {
    const blob = `${c.data ?? ''}\n${c.content ?? ''}`;
    const kind = /\bkind:\s*([A-Za-z]+)/.exec(blob)?.[1] ?? 'unknown';
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    // Anything that looks like a sub-resource: a folder path, a space list, a page id,
    // a site-relative path. Printed verbatim so the scoping shape is visible.
    const refs = [...blob.matchAll(/\b(?:url|siteUrl|folderPath|path|spaceKey|spaceId|pageId|listId|driveId|entityName|sharePointSiteUrl):\s*([^\n]+)/gi)]
      .map((m) => `${m[0].split(':')[0].trim()}=${m[1].trim().slice(0, 90)}`);
    if (refs.length) scoped.push(`  [${kind}] ${(c.name ?? '').slice(0, 40)} :: ${refs.slice(0, 4).join(' | ')}`);
    else if (c.description) scoped.push(`  [${kind}] ${(c.name ?? '').slice(0, 40)} :: desc="${String(c.description).slice(0, 90)}"`);
  }
  console.log(`knowledge sources: ${ks.length}`);
  for (const [k, n] of [...kinds].sort((a, b) => b[1] - a[1])) console.log(`   ${n.toString().padStart(3)}  ${k}`);
  console.log('scoping signals:');
  for (const line of scoped.slice(0, 25)) console.log(line);

  // ── tools (componenttype 9, kind: TaskDialog) ───────────────────────────
  const comps = await all(env, token, "botcomponents?$select=name,data,content,schemaname&$filter=componenttype eq 9 and statecode eq 0");
  const tools = comps.filter((c) => /^\s*kind:\s*TaskDialog\s*$/m.test(`${c.data ?? ''}\n${c.content ?? ''}`));
  let withDesc = 0, withOp = 0, withInputs = 0, custom = 0;
  const toolKinds = new Map<string, number>();
  const samples: string[] = [];
  for (const t of tools) {
    const blob = `${t.data ?? ''}\n${t.content ?? ''}`;
    const action = /\bkind:\s*(Invoke[A-Za-z]+Action|HttpRequestAction|[A-Za-z]*ConnectorTask[A-Za-z]*)/.exec(blob)?.[1] ?? 'other';
    toolKinds.set(action, (toolKinds.get(action) ?? 0) + 1);
    const desc = /^\s*modelDescription:\s*(.+)$/m.exec(blob)?.[1]?.trim();
    const op = /\boperationId:\s*([^\n]+)/.exec(blob)?.[1]?.trim();
    // "inputs:" / "parameters:" blocks are the author's BOUND arguments — the thing that
    // makes the migrated call identical rather than merely similar.
    const inputs = /^\s*(inputs|parameters):\s*$/m.test(blob);
    if (desc) withDesc++;
    if (op) withOp++;
    if (inputs) withInputs++;
    if (/HttpRequestAction|customApi|apiDefinition/i.test(blob)) custom++;
    if (samples.length < 8 && (desc || op)) {
      samples.push(`  ${(t.name ?? '').slice(0, 34).padEnd(34)} op=${(op ?? '-').slice(0, 26).padEnd(26)} inputs=${inputs} desc=${desc ? '"' + desc.slice(0, 60) + '"' : '-'}`);
    }
  }
  console.log(`\ntools (TaskDialog): ${tools.length}`);
  for (const [k, n] of [...toolKinds].sort((a, b) => b[1] - a[1])) console.log(`   ${n.toString().padStart(3)}  ${k}`);
  console.log(`   with modelDescription: ${withDesc}/${tools.length}   with operationId: ${withOp}/${tools.length}   with input bindings: ${withInputs}/${tools.length}   http/custom-api shaped: ${custom}`);
  for (const s of samples) console.log(s);
}
process.exit(0);
