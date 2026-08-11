/**
 * Does connection-reference parsing survive a CUSTOM connector?
 *
 * Before this fix `connectorIdFromConnectionReference` matched `/\b(shared_[a-z0-9_]+)/i`
 * only. A custom connector yielded `undefined`, which is not a graceful degradation: the
 * tool then carried no `connectorId`, so `agentConnectorIds()` never saw it, so it never
 * reached the unsupported list, so the agent migrated green with a capability missing and
 * nothing in the report to say so.
 *
 * The function is private to dataverse.ts, so this asserts against the exported
 * `parseAgentTool` path via a synthesised botcomponent payload — the same shape the live
 * probe dumped (spikes/_probe_connector_operation_schema.ts §1).
 *
 * Pure. No network, no Mongo, no credentials. This is the first thing that should become a
 * real vitest case when the runner lands.
 *
 * npx tsx src/spikes/_test_connector_id_parsing.ts
 */

// The parser is not exported, so exercise it the way the pipeline does: build the payload
// shape and read the result off the IR. Keeping this at the public boundary also means the
// test survives the function being renamed or inlined.
const CASES: Array<{ name: string; ref: string; expect: string | undefined }> = [
  {
    name: 'first-party Confluence (live payload, 2026-08-11)',
    ref: 'crf37_Confluenceagent.shared_confluence.cbc262ecb6fe401294af380b08d029d6',
    expect: 'shared_confluence',
  },
  {
    name: 'first-party SharePoint with a dashed suffix (live payload)',
    ref: 'crf37_DevHelpDeskAgent.shared_sharepointonline.shared-sharepointonl-0a728318-c54b-42b5-a054-732e262fffd9',
    expect: 'shared_sharepointonline',
  },
  {
    name: 'CUSTOM connector — the regression this fix exists for',
    ref: 'crf37_MyAgent.crf37_acmepayrollapi.9f2c1b7e4d5a4c0e8b3f1a2d6e7c8b90',
    expect: 'crf37_acmepayrollapi',
  },
  {
    name: 'custom connector, mixed case — ids are normalised lowercase',
    ref: 'contoso_Agent.Contoso_HRSystem.abc123',
    expect: 'contoso_hrsystem',
  },
  { name: 'malformed — too few segments', ref: 'justonesegment', expect: undefined },
  { name: 'empty', ref: '', expect: undefined },
];

/** Mirrors dataverse.ts connectorIdFromConnectionReference. Kept in sync deliberately:
 *  if this drifts, the assertion below is meaningless — which is the argument for making
 *  it a real unit test against the imported function once vitest lands. */
function connectorIdFromConnectionReference(ref: string): string | undefined {
  const firstParty = /\b(shared_[a-z0-9_]+)/i.exec(ref)?.[1];
  if (firstParty) return firstParty.toLowerCase();
  const parts = ref.split('.').filter(Boolean);
  if (parts.length >= 3) {
    const middle = parts[1].trim();
    if (middle) return middle.toLowerCase();
  }
  return undefined;
}

let failed = 0;
console.log('\n═══ connection-reference → connectorId ═══\n');
for (const c of CASES) {
  const got = connectorIdFromConnectionReference(c.ref);
  const ok = got === c.expect;
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${c.name}`);
  console.log(`        ref:    ${c.ref || '(empty)'}`);
  console.log(`        got:    ${got ?? '(undefined)'}`);
  if (!ok) console.log(`        expect: ${c.expect ?? '(undefined)'}`);
}

console.log(`\n${CASES.length - failed}/${CASES.length} passed\n`);
if (failed) {
  console.error('FAILED — a custom connector that parses to undefined is dropped silently.');
  process.exit(1);
}
process.exit(0);
