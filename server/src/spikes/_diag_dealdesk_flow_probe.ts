/** Live probe: for the "Deal Desk" agent, walk bot -> botcomponents -> flow-tool -> workflow
 *  clientdata, and report what's actually fetchable (trigger inputs, action graph, conditions,
 *  expressions, connectors) versus what this repo's extraction code parses today.
 *  Read-only (GET only). npx tsx src/spikes/_diag_dealdesk_flow_probe.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
import type { Session } from '../sessionStore.js';

await connectMongo();
const s = (await getDb()
  .collection('migrationSessions')
  .find({ tenantId: { $exists: true }, dvOrgUrl: { $exists: true } })
  .sort({ $natural: -1 })
  .limit(1)
  .next()) as Session | null;

if (!s || !s.tenantId || !s.dvOrgUrl) {
  console.log('NO_USABLE_SESSION');
  process.exit(0);
}

const base = s.dvOrgUrl.replace(/\/$/, '');
const token = await clientCredsToken(s.tenantId, s.dvOrgUrl);
const h = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

console.log(`org: ${base}`);

// 1. Find the bot by name.
const botRes = await fetch(`${base}/api/data/v9.2/bots?$filter=${encodeURIComponent("name eq 'Deal Desk'")}&$select=botid,name,statecode`, { headers: h });
const botJson = (await botRes.json()) as { value?: Array<{ botid: string; name: string; statecode: number }>; error?: unknown };
if (!botJson.value?.length) {
  console.log('BOT_NOT_FOUND', JSON.stringify(botJson).slice(0, 500));
  process.exit(0);
}
const bot = botJson.value[0];
console.log(`\nAgent: ${bot.name} (${bot.botid}), statecode=${bot.statecode}`);

// 2. All its components.
const compRes = await fetch(
  `${base}/api/data/v9.2/botcomponents?$select=name,data,content,componenttype,schemaname&$filter=${encodeURIComponent(`_parentbotid_value eq ${bot.botid}`)}&$top=500`,
  { headers: h },
);
const compJson = (await compRes.json()) as { value?: Array<{ name: string; data?: string; content?: string; componenttype: number; schemaname?: string }> };
const comps = compJson.value ?? [];
console.log(`Components: ${comps.length}`);

// 3. Which ones are flow-backed tools? (kind: TaskDialog + invokeflowtaskaction, carries a flowId:)
const flowTools: Array<{ name: string; flowId: string }> = [];
for (const c of comps) {
  const blob = c.data || c.content || '';
  if (!/invokeflowtaskaction/i.test(blob)) continue;
  const m = /^\s*flowId:\s*(\S+)\s*$/im.exec(blob);
  if (m) flowTools.push({ name: c.name, flowId: m[1] });
}
console.log(`\nFlow-backed tools found: ${flowTools.length}`);
for (const t of flowTools) console.log(`  - ${t.name} -> workflowid ${t.flowId}`);

// 4. Fetch each flow's real definition.
for (const t of flowTools) {
  console.log(`\n${'='.repeat(60)}\nFLOW: ${t.name}`);
  const wfRes = await fetch(`${base}/api/data/v9.2/workflows(${t.flowId})?$select=workflowid,name,category,clientdata`, { headers: h });
  if (!wfRes.ok) {
    console.log(`  fetch failed: ${wfRes.status}`);
    continue;
  }
  const wf = (await wfRes.json()) as { name: string; category: number; clientdata?: string };
  console.log(`  Dataverse name: ${wf.name}, category: ${wf.category}`);
  if (!wf.clientdata) {
    console.log('  NO clientdata on this row');
    continue;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(wf.clientdata);
  } catch (e) {
    console.log(`  clientdata is not valid JSON: ${(e as Error).message}`);
    continue;
  }
  const def = parsed.properties?.definition ?? parsed.definition;
  const connRefs = parsed.properties?.connectionReferences ?? parsed.connectionReferences;
  console.log(`  clientdata size: ${wf.clientdata.length} chars`);
  console.log(`  connectionReferences: ${connRefs ? Object.keys(connRefs).join(', ') : 'none found'}`);

  if (!def) {
    console.log('  NO definition object found under properties.definition or definition');
    continue;
  }

  const triggers = def.triggers ?? {};
  console.log(`  Triggers: ${Object.keys(triggers).join(', ') || 'none'}`);
  for (const [tname, tval] of Object.entries<any>(triggers)) {
    console.log(`    "${tname}" type=${tval.type} kind=${tval.kind ?? '-'}`);
    const schema = tval.inputs?.schema?.properties;
    if (schema) console.log(`      input fields: ${Object.keys(schema).join(', ')}`);
  }

  function describeActions(actions: Record<string, any> | undefined, depth: number) {
    if (!actions) return;
    const pad = '  '.repeat(depth + 2);
    for (const [aname, aval] of Object.entries(actions)) {
      console.log(`${pad}- "${aname}" type=${aval.type}${aval.expression ? ` expr=${JSON.stringify(aval.expression).slice(0, 80)}` : ''}`);
      if (aval.actions) describeActions(aval.actions, depth + 1);
      if (aval.else?.actions) {
        console.log(`${pad}  [else branch]`);
        describeActions(aval.else.actions, depth + 1);
      }
      if (aval.cases) {
        for (const [caseName, caseVal] of Object.entries<any>(aval.cases)) {
          console.log(`${pad}  [case ${caseName}]`);
          describeActions(caseVal.actions, depth + 1);
        }
      }
    }
  }
  console.log('  Actions (with nesting):');
  describeActions(def.actions, 0);

  console.log('\n  ---- FULL RAW definition (every field, unsummarized) ----');
  console.log(JSON.stringify(def, null, 2));
  console.log('\n  ---- FULL RAW connectionReferences ----');
  console.log(JSON.stringify(connRefs ?? {}, null, 2));
}
process.exit(0);
