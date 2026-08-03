/**
 * Fixture tests for the knowledge planner + import reconciliation (step 2 spine).
 * Run: cd server && npx tsx src/_test_knowledge_plan.ts
 */
import { classifyKnowledgeSource } from './services/knowledgeClassifier.js';
import { planKnowledgeMigration, sanitizeDataStoreId } from './services/knowledgePlanner.js';
import { reconcileImport } from './services/importReconcile.js';
import type { KnowledgeSourceIR } from './types.js';

let passed = 0;
let failed = 0;
const log: string[] = [];
function check(name: string, cond: boolean, detail = '') {
  if (cond) passed++;
  else failed++;
  log.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  ← ${detail}`}`);
}

// Build a classified source the way extraction does.
function ks(id: string, name: string, kind: string, opts: Partial<KnowledgeSourceIR> = {}): KnowledgeSourceIR {
  const classification = classifyKnowledgeSource({ kind, references: opts.references, file: opts.file });
  return { id, name, kind, classification, ...opts };
}

// ── Planner ───────────────────────────────────────────────────────────────
const sources: KnowledgeSourceIR[] = [
  ks('u1', 'HR Policy', 'FileUpload', { file: { name: 'HR Policy.pdf', sizeBytes: 2_000_000 } }),
  ks('u2', 'Handbook', 'FileUpload', { file: { name: 'Handbook.docx', sizeBytes: 3_000_000 } }),
  ks('w1', 'Help site', 'PublicSiteSearch', { references: ['https://company.com/help'] }),
  ks('w2', 'Docs site', 'PublicSiteSearch', { references: ['https://company.com/docs'] }),
  ks('sp', 'HR SharePoint', 'SharePointSource', { references: ['https://contoso.sharepoint.com/sites/HR'] }),
  ks('dv', 'Accounts', 'DataverseQnA', { references: ['account'] }),
  ks('bad', 'Mystery', 'FutureThing'),
];

const plan = planKnowledgeMigration('SalesAgent_2f9c', sources);

const docs = plan.actions.find((a) => a.geminiTarget === 'document-data-store');
check('uploads folded into ONE document data store', !!docs && docs.sourceIds.length === 2, JSON.stringify(docs?.sourceIds));
check('document store id is DNS-safe', !!docs && /^[a-z0-9-]{1,63}$/.test(docs!.dataStoreId!), docs?.dataStoreId);
check('document action is automatable', !!docs?.automatable);

const web = plan.actions.find((a) => a.geminiTarget === 'website-data-store');
check('websites folded into ONE website data store', !!web && web.sourceIds.length === 2, JSON.stringify(web?.sourceIds));
check('website URLs merged + deduped', !!web && web.references?.length === 2, JSON.stringify(web?.references));
check('website is NOT auto (needs domain verification)', !!web && web.automatable === false, JSON.stringify(web?.automatable));

const sp = plan.actions.find((a) => a.strategy === 'reconnect');
check('SharePoint → its own reconnect action', !!sp && sp.sourceIds.length === 1);
check('reconnect is NOT automatable', !!sp && sp.automatable === false);
check('reconnect has identity-federation manual step', !!sp?.manualSteps?.some((s) => /Identity Federation/i.test(s)));

const dv = plan.actions.find((a) => a.strategy === 'rebuild-as-tool');
check('Dataverse → rebuild-as-tool action', !!dv && dv.automatable === false);

const mr = plan.actions.find((a) => a.strategy === 'manual-review');
check('unknown source → manual-review action', !!mr);

check('summary counts add up', plan.summary.total === plan.actions.length && plan.summary.automatable + plan.summary.manual === plan.summary.total,
  JSON.stringify(plan.summary));
check('exactly 1 automatable action (docs only; website needs verification)', plan.summary.automatable === 1, JSON.stringify(plan.summary));

// sanitizer edge cases
check('sanitize strips illegal chars', sanitizeDataStoreId('My Store!!@#') === 'my-store');
check('sanitize caps length ≤63', sanitizeDataStoreId('a'.repeat(200)).length <= 63);

// ── Reconciliation ──────────────────────────────────────────────────────────
const clean = reconcileImport(
  { done: true, metadata: { successCount: 18, failureCount: 0, totalCount: 18 } },
  18,
);
check('clean import → allIndexed true (18/18)', clean.allIndexed && clean.succeeded === 18 && clean.failed === 0);

const partial = reconcileImport(
  { done: true, metadata: { successCount: 15, failureCount: 3, totalCount: 18 },
    response: { errorSamples: [{ document: 'gs://b/scan.pdf', errorMessage: 'no extractable text' }] } },
  18,
);
check('partial import → not allIndexed, 3 failed', !partial.allIndexed && partial.failed === 3);
check('partial import surfaces a failure sample', partial.failureSamples.length >= 1, JSON.stringify(partial.failureSamples));

// The silent gap: we uploaded 18 but the op only accounts for 12 → 6 unaccounted counted as failed.
const gap = reconcileImport({ done: true, metadata: { successCount: 12, failureCount: 0, totalCount: 12 } }, 18);
check('silent gap: 18 uploaded, op says 12 → 6 counted failed, NOT allIndexed',
  !gap.allIndexed && gap.failed === 6, JSON.stringify({ succeeded: gap.succeeded, failed: gap.failed, allIndexed: gap.allIndexed }));

const errored = reconcileImport({ done: true, error: { code: 3, message: 'invalid bucket' } }, 18);
check('operation-level error → not complete-clean', !errored.allIndexed && !!errored.operationError);

const running = reconcileImport({ done: false, metadata: { successCount: 4 } }, 18);
check('still-running op → complete=false', running.complete === false);

console.log(log.join('\n'));
console.log(`\n${passed} passed, ${failed} failed`);
console.log('\nPlan preview:');
console.log(JSON.stringify(plan, null, 2));
process.exit(failed === 0 ? 0 : 1);
