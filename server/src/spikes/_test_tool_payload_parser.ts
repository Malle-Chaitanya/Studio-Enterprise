/**
 * Run the new payload parser over EVERY live TaskDialog in both environments and report
 * what it recovered. Unit tests prove the parser handles shapes we wrote down; this proves
 * it handles the shapes the tenant actually has.
 *
 * Prints counts and field names only — no customer values.
 * npx tsx src/spikes/_test_tool_payload_parser.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { parseToolInputs, parseOutputSchema, parseMcpBinding, parseFlowId, parseAiPluginRef } from '../services/toolPayload.js';

const ENVS = ['https://org32322095.crm.dynamics.com', 'https://orga243378d.crm.dynamics.com'];
await connectMongo();
const row = (await getDb().collection('environmentsCache').find({ tenantId: { $exists: true } })
  .sort({ $natural: -1 }).limit(1).next()) as { tenantId?: string } | null;

let tools = 0, withInputs = 0, fixed = 0, modelFilled = 0, unknownKind = 0, exprs = 0;
let withSchema = 0, schemaFields = 0, mcp = 0, mcpSpecific = 0, mcpUnknown = 0, flows = 0, plugins = 0;
const unknownKinds = new Set<string>();

for (const env of ENVS) {
  const token = await clientCredsToken(row!.tenantId!, env);
  // Paged. The first version of this spike read one page and reported 42 of 63 tools as
  // though that were the whole tenant — the same silent truncation the pipeline was just
  // fixed for. Probes are not exempt from it.
  const comps: Array<{ name?: string; data?: string; content?: string }> = [];
  let next: string | null =
    `${env}/api/data/v9.2/botcomponents?$select=name,data,content&$filter=componenttype eq 9 and statecode eq 0`;
  while (next) {
    const res: Response = await fetch(next, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', Prefer: 'odata.maxpagesize=500' },
    });
    if (!res.ok) { console.log(`  ${res.status} listing components`); break; }
    const j = (await res.json()) as any;
    comps.push(...(j.value ?? []));
    next = j['@odata.nextLink'] ?? null;
  }
  for (const c of comps) {
    const blob = `${c.data ?? ''}\n${c.content ?? ''}`;
    if (!/^\s*kind:\s*TaskDialog\s*$/m.test(blob)) continue;
    tools++;
    const inputs = parseToolInputs(blob);
    if (inputs.length) withInputs++;
    for (const i of inputs) {
      if (i.source === 'fixed') fixed++;
      else if (i.source === 'model') modelFilled++;
      else { unknownKind++; if (i.rawKind) unknownKinds.add(i.rawKind); }
      if (i.isExpression) exprs++;
    }
    const schema = parseOutputSchema(blob);
    if (schema.length) { withSchema++; schemaFields += schema.length; }
    const m = parseMcpBinding(blob);
    if (m) { mcp++; if (m.toolSelection === 'specific') mcpSpecific++; if (m.toolSelection === 'unknown') mcpUnknown++; }
    if (parseFlowId(blob)) flows++;
    if (parseAiPluginRef(blob)) plugins++;
  }
}

console.log(`
TaskDialogs parsed          ${tools}
  with input bindings       ${withInputs}
    fixed arguments         ${fixed}   (of which Power Fx expressions: ${exprs})
    model-filled arguments  ${modelFilled}
    unrecognised kinds      ${unknownKind}${unknownKinds.size ? ' -> ' + [...unknownKinds].join(', ') : ''}
  with output schema        ${withSchema}  (${schemaFields} fields total)
  MCP servers               ${mcp}  (allow-listed: ${mcpSpecific}, no list stated: ${mcpUnknown})
  Power Automate flows      ${flows}
  AI plugins (custom API)   ${plugins}
`);
process.exit(0);
