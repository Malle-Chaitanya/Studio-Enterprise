/** Print the equivalence table's real counts, so docs quote computed numbers not hand tallies.
 *  cd server && npx tsx src/spikes/_dump_equivalence.ts */
import { EQUIVALENCES, OUTLOOK_MAIL, summarise, describeEquivalence } from '../connectors/equivalence.js';
import { TEAMS_MESSAGING } from '../connectors/teamsEquivalence.js';

const pct = (n: number, d: number) => `${Math.round((n / d) * 100)}%`;

const mail = summarise(OUTLOOK_MAIL);
console.log('OUTLOOK MAIL');
console.log(`  total ${mail.total}  exact ${mail.exact} (${pct(mail.exact, mail.total)})  narrowed ${mail.narrowed} (${pct(mail.narrowed, mail.total)})  lost ${mail.lost} (${pct(mail.lost, mail.total)})`);
console.log(`  proven live: ${mail.verified}`);
console.log(`  migrates in some form: ${mail.exact + mail.narrowed}/${mail.total} = ${pct(mail.exact + mail.narrowed, mail.total)}`);

// The KEEP-MICROSOFT path is a separate, equally real answer: the agent moves to Gemini and
// its mail stays in M365. Counting only the Gmail column understates what a customer can do.
const withGraph = OUTLOOK_MAIL.filter((e) => e.graph);
const graphTooled = withGraph.filter((e) => e.graph!.tool);
const graphProven = withGraph.filter((e) => e.graph!.verified);
console.log('\nOUTLOOK MAIL -> KEEP OUTLOOK (Microsoft Graph)');
console.log(`  mapped to a Graph call: ${withGraph.length}/${OUTLOOK_MAIL.length}`);
console.log(`  backed by a built tool : ${graphTooled.length}`);
console.log(`  proven live            : ${graphProven.length}`);

// Teams. Reported separately from mail because NOTHING here is proven yet, and folding it
// into one total would let 0 live runs hide behind mail's 17.
const t = summarise(TEAMS_MESSAGING);
const tChat = TEAMS_MESSAGING.filter((e) => e.tool);
const tGraph = TEAMS_MESSAGING.filter((e) => e.graph?.tool);
console.log('\nTEAMS (53 source operations, bucketed into ' + t.total + ' rows)');
console.log(`  exact ${t.exact}  narrowed ${t.narrowed}  lost ${t.lost}`);
console.log(`  -> USE GOOGLE CHAT   ${tChat.length} rows backed by a built tool, ${t.verified} proven live`);
console.log(`  -> KEEP TEAMS        ${tGraph.length} rows backed by a built tool, ${TEAMS_MESSAGING.filter((e) => e.graph?.verified).length} proven live`);
console.log('  NOTE: 0 proven. 23 tools written, none exercised against a live tenant.');

const all = summarise();
console.log('\nWHOLE TABLE');
console.log(`  total ${all.total}  exact ${all.exact}  narrowed ${all.narrowed}  lost ${all.lost}  verified ${all.verified}`);

console.log('\nLOST ROWS');
for (const e of EQUIVALENCES.filter((x) => x.fidelity === 'lost')) {
  console.log(`  - ${e.operationId}: ${e.label}`);
}

console.log('\nCUSTOMER SENTENCES (verified rows)');
for (const e of EQUIVALENCES.filter((x) => x.verified)) console.log(`  * ${describeEquivalence(e)}`);
process.exit(0);
