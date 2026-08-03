/**
 * Fixture tests for the knowledge planner + import reconciliation (step 2 spine).
 * Run: cd server && npx tsx src/spikes/_test_knowledge_plan.ts
 */
import { classifyKnowledgeSource } from '../services/knowledgeClassifier.js';
import { planKnowledgeMigration, sanitizeDataStoreId } from '../services/knowledgePlanner.js';
import { reconcileImport } from '../services/importReconcile.js';
import type { KnowledgeSourceIR } from '../types.js';

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
  // ^ w1/w2: public-website handling was removed entirely — these now fall
  // through to manual-review, one action each (no website data store, no
  // ownership check). Kept in the fixture set to prove the reference survives
  // losslessly even though no automatic strategy applies.
  ks('dv', 'Accounts', 'DataverseQnA', { references: ['account'] }),
  ks('bad', 'Mystery', 'FutureThing'),
];

const plan = planKnowledgeMigration('SalesAgent_2f9c', sources);

const docs = plan.actions.find((a) => a.geminiTarget === 'document-data-store');
check('uploads folded into ONE document data store', !!docs && docs.sourceIds.length === 2, JSON.stringify(docs?.sourceIds));
check('document store id is DNS-safe', !!docs && /^[a-z0-9-]{1,63}$/.test(docs!.dataStoreId!), docs?.dataStoreId);
check('document action is automatable', !!docs?.automatable);

const websiteActions = plan.actions.filter((a) => a.sourceIds[0] === 'w1' || a.sourceIds[0] === 'w2');
check('website sources are NOT folded — one manual-review action each', websiteActions.length === 2, JSON.stringify(websiteActions.map((a) => a.sourceIds)));
check('website actions are manual-review, not automatable', websiteActions.every((a) => a.strategy === 'manual-review' && !a.automatable));
check('website reference is preserved losslessly', websiteActions.every((a) => a.references?.length === 1));

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
check('exactly 1 automatable action (docs only)', plan.summary.automatable === 1, JSON.stringify(plan.summary));
check('6 total actions (docs folded + 5 individual: w1, w2, sp, dv, bad)', plan.summary.total === 6, JSON.stringify(plan.summary));

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
