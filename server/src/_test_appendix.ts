/**
 * Test the configurable "Additional Knowledge References" appendix.
 * Run: cd server && npx tsx src/_test_appendix.ts
 */
import { mapAgent, buildKnowledgeReferencesAppendix } from './services/mapper.js';
import { classifyKnowledgeSource } from './services/knowledgeClassifier.js';
import type { AgentIR, KnowledgeSourceIR } from './types.js';

let passed = 0, failed = 0;
const rows: string[] = [];
const check = (name: string, cond: boolean, extra = '') => {
  if (cond) passed++; else failed++;
  rows.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  ← ${extra}`}`);
};

const ks = (id: string, name: string, kind: string, o: Partial<KnowledgeSourceIR> = {}): KnowledgeSourceIR => ({
  id, name, kind, classification: classifyKnowledgeSource({ kind, references: o.references, file: o.file }), ...o,
});

const ir: AgentIR = {
  sourceId: 'A', name: 'Service Operations Agent',
  instructions: 'You are a Service Operations Agent. Help troubleshoot Dynamics 365 Contact Center.',
  description: 'D365', capabilities: { webBrowsing: true, codeInterpreter: false }, starterPrompts: [], topics: [], unmapped: [],
  knowledgeSources: [
    ks('f', 'Instructions.txt', 'FileUpload', { file: { name: 'Instructions.txt' } }),
    ks('w', 'D365 docs', 'PublicSiteSearch', {
      references: ['https://learn.microsoft.com/en-us/dynamics365'],
      description: 'Used to answer questions about Dynamics 365 Contact Center.',
    }),
  ],
};

// Appendix content: AI-usable knowledge references, NOT migration audit.
const appendix = buildKnowledgeReferencesAppendix(ir);
check('appendix names the website URL', /learn\.microsoft\.com/.test(appendix));
check('appendix has separated header', /Additional Knowledge References/.test(appendix));
check('appendix excludes the uploaded file', !/Instructions\.txt/.test(appendix), appendix.slice(0, 120));
check('appendix carries the purpose/description', /answer questions about Dynamics 365/.test(appendix));
check('appendix is AI-oriented (behavioral cue)', /authoritative references/i.test(appendix));
check('appendix has NO migration-audit jargon', !/(not imported|verification|platform limitation|migration note)/i.test(appendix), appendix);

// Default (report-only): instruction UNCHANGED (no appendix, no URL).
const def = await mapAgent(ir);
check('default report-only → no appendix in instruction', !/Additional Knowledge References/.test(def.instruction));
check('default report-only → no raw URL in instruction', !/learn\.microsoft\.com/.test(def.instruction));

// appendix mode: instruction gets the separated block, behavior text intact.
const app = await mapAgent(ir, { unsupportedKnowledgeHandling: 'appendix' });
check('appendix mode → block present', /Additional Knowledge References/.test(app.instruction));
check('appendix mode → original behavior text intact', /Help troubleshoot Dynamics 365/.test(app.instruction));
check('appendix mode → block is AFTER behavior (separated)', app.instruction.indexOf('Additional Knowledge References') > app.instruction.indexOf('Service Operations Agent'));

// skip mode: same as report-only for the instruction.
const skip = await mapAgent(ir, { unsupportedKnowledgeHandling: 'skip' });
check('skip mode → no appendix', !/Additional Knowledge References/.test(skip.instruction));

console.log(rows.join('\n'));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
