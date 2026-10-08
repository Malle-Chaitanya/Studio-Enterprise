/**
 * Which agents in this tenant use an MCP server, and what each binding actually says.
 *
 *   npx tsx src/spikes/_probe_mcp_inventory.ts
 *   DV_ORG=https://otherorg.crm.dynamics.com npx tsx src/spikes/_probe_mcp_inventory.ts
 *
 * Uses the SAME parser the pipeline uses (`parseMcpBinding`), so what this prints is what
 * extraction would produce — not a second opinion that can drift from it.
 *
 * Read-only, app-only Dataverse.
 */
import { clientCredsToken } from '../auth/microsoft.js';
import { parseMcpBinding } from '../services/toolPayload.js';

const ORG = process.env.DV_ORG || 'https://org32322095.crm.dynamics.com';
const APP = process.env.MS_APP_ID || '807d6772-847c-40e2-9bec-e2c930b3a42e';

const token = await clientCredsToken(APP, ORG);
const h = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
const api = `${ORG}/api/data/v9.2`;

const br = await fetch(`${api}/bots?$select=botid,name&$filter=statecode eq 0`, { headers: h });
const bots = (JSON.parse(await br.text()).value ?? []) as { botid: string; name: string }[];
console.log(`scanning ${bots.length} agent(s) in ${ORG}\n`);

let agentsWithMcp = 0;
let bindings = 0;

for (const bot of bots) {
  // componenttype 9 is the tool/action row; the MCP metadata lives in its `data` blob.
  const cr = await fetch(
    `${api}/botcomponents?$select=name,data&$filter=statecode eq 0 and _parentbotid_value eq ${bot.botid} and componenttype eq 9`,
    { headers: h },
  );
  if (!cr.ok) {
    console.log(`${bot.name}: components unreadable (HTTP ${cr.status})`);
    continue;
  }
  const comps = (JSON.parse(await cr.text()).value ?? []) as { name?: string; data?: string }[];

  const hits: string[] = [];
  for (const c of comps) {
    const data = `${c.data ?? ''}`;
    const mcp = parseMcpBinding(data);
    if (!mcp) continue;
    bindings++;
    const connector = (data.match(/shared_[a-zA-Z0-9_-]+/) ?? [])[0] ?? '(no connector id)';
    const sel = mcp.toolSelection;
    const list = sel === 'specific' ? `${(mcp.tools ?? []).length} tool(s): ${(mcp.tools ?? []).join(', ') || '(none listed)'}` : 'ALL tools the server exposes';
    hits.push(
      `    ${(c.name ?? '(unnamed)').padEnd(34)} ${connector}\n` +
        `      selection : ${sel} — ${list}\n` +
        `      operation : ${mcp.operationId ?? '(none)'}\n` +
        `      serverUrl : ${mcp.serverUrl ?? '(absent — resolved later from the custom connector host)'}`,
    );
  }
  if (hits.length) {
    agentsWithMcp++;
    console.log(`\n### ${bot.name}  (${bot.botid})  — ${hits.length} MCP tool(s)`);
    console.log(hits.join('\n'));
  }
}

console.log(
  `\n─────\n${agentsWithMcp} of ${bots.length} agent(s) use MCP; ${bindings} binding(s) total.`,
);
process.exit(0);
