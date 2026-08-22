/**
 * Parser vs LLM, on the same raw payload. Finds what our parsers MISS.
 *
 * The parser extracts identifiers exactly but only in the shapes it was written for. The
 * LLM reads intent, so it survives structural drift but cannot be trusted with an id.
 * Running both on one payload and diffing turns each one's weakness into the other's job:
 *
 *   both        — high confidence the parser is right
 *   parserOnly  — the model missed it (prompt weakness, not a parser bug)
 *   llmOnly     — POSSIBLE PARSER BLIND SPOT. This is the §1.23 signal.
 *
 * §1.23 is the validation case: five Dataverse agents bound ZERO operations because a
 * topic-embedded `InvokeConnectorAction` was not the shape the TaskDialog parser expected.
 * 45 → 71 operations once fixed. If this probe surfaces that class of miss on its own, the
 * approach is proven on a case whose answer we already know.
 *
 * Read-only. Extracts live, calls the LLM, writes nothing.
 *
 * Run:
 *   cd server && npx tsx src/spikes/_diag_blind_spot.ts [nameFilter] [envUrl]
 *
 * Needs an LLM key (OPENAI_API_KEY is enough — see agent/callAI.ts).
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots, extractAgent, type RawAgentPayload } from '../services/dataverse.js';
import { llmExtractTools, diffTools, summariseDiff } from '../services/blindSpot.js';
import { agentLlmConfigured } from '../agent/callAI.js';

const NAME = process.argv[2] ?? '';
const ENV = process.argv[3] ?? 'https://org32322095.crm.dynamics.com';
const LIMIT = Number(process.argv[4] ?? 5);

async function main(): Promise<void> {
  if (!agentLlmConfigured()) {
    console.error('No LLM configured. Set OPENAI_API_KEY in server/.env.');
    process.exit(1);
  }

  await connectMongo();
  const row = (await getDb()
    .collection('environmentsCache')
    .find({ tenantId: { $exists: true } })
    .sort({ $natural: -1 })
    .limit(1)
    .next()) as { tenantId?: string } | null;
  if (!row?.tenantId) {
    console.error('No tenantId in environmentsCache — connect Microsoft in the UI first.');
    process.exit(1);
  }

  const token = await clientCredsToken(row.tenantId, ENV);
  const all = await listBots(ENV, token);
  const bots = (NAME ? all.filter((b) => b.name.toLowerCase().includes(NAME.toLowerCase())) : all).slice(0, LIMIT);

  console.log(`env: ${ENV}`);
  console.log(`agents: ${bots.length}${NAME ? ` (filter "${NAME}")` : ''} of ${all.length}\n`);

  const totals = { both: 0, parserOnly: 0, llmOnly: 0, suspects: 0 };

  for (const bot of bots) {
    let raw: RawAgentPayload | undefined;
    const ir = await extractAgent(ENV, token, bot, (r) => {
      raw = r;
    });
    const parserTools = ir.agentTools ?? [];

    if (!raw) {
      console.log(`### ${bot.name}\n  no raw payload captured — skipped\n`);
      continue;
    }

    const llm = await llmExtractTools(raw.components);
    if (llm.error) {
      console.log(`### ${bot.name}\n  LLM extraction failed: ${llm.error}\n`);
      continue;
    }

    const diff = diffTools(parserTools, llm.tools);
    totals.both += diff.both.length;
    totals.parserOnly += diff.parserOnly.length;
    totals.llmOnly += diff.llmOnly.length;
    totals.suspects += diff.llmOnly.filter((t) => t.confidence !== 'low').length;

    console.log(`### ${bot.name}`);
    console.log(
      `  components=${raw.components.length}  parser=${parserTools.length}  llm=${llm.tools.length}  ` +
        `both=${diff.both.length} parserOnly=${diff.parserOnly.length} llmOnly=${diff.llmOnly.length}`,
    );

    for (const t of diff.llmOnly) {
      const flag = t.confidence === 'low' ? '  (low)' : '  ** REVIEW **';
      console.log(
        `    LLM-ONLY${flag} "${t.name}"` +
          `${t.operationHint ? ` op=${t.operationHint}` : ''}` +
          `${t.connectorHint ? ` conn=${t.connectorHint}` : ''}` +
          `${t.foundIn ? ` in=${t.foundIn}` : ''}`,
      );
      if (t.description) console.log(`             desc: ${t.description.slice(0, 120)}`);
    }
    for (const p of diff.parserOnly) {
      console.log(`    parser-only  "${p.name}" op=${p.operationId ?? '-'} (model missed it)`);
    }
    console.log(`  ${summariseDiff(diff)}\n`);
  }

  console.log('─'.repeat(70));
  console.log(
    `TOTALS  confirmed=${totals.both}  parserOnly=${totals.parserOnly}  ` +
      `llmOnly=${totals.llmOnly}  to-review=${totals.suspects}`,
  );
  if (totals.suspects) {
    console.log(
      '\nEach "to-review" is a LEAD, not a verdict. Open the named component, confirm by hand,\n' +
        'then fix the PARSER — deterministically, with a test. Nothing here binds an operation.',
    );
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('FAILED:', (e as Error).message);
  process.exit(1);
});
