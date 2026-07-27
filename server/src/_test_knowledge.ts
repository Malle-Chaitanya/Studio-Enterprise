/**
 * Fixture test for the knowledge-source classifier.
 * Run: cd server && npx tsx src/_test_knowledge.ts
 *
 * Proves the discovery+classifier step WITHOUT a live Dataverse connection —
 * fixtures mirror the shapes real KnowledgeSourceConfiguration payloads take.
 */
import {
  classifyKnowledgeSource,
  checkFileCompatibility,
  type ClassifierInput,
  type KnowledgeStrategy,
} from './services/knowledgeClassifier.js';

interface Case {
  label: string;
  input: ClassifierInput;
  expectStrategy: KnowledgeStrategy;
  expectAutomatable: boolean;
}

const cases: Case[] = [
  {
    label: 'Uploaded PDF (HR Policy.pdf)',
    input: { kind: 'FileUpload', file: { name: 'HR Policy.pdf', sizeBytes: 2_400_000 } },
    expectStrategy: 'copy-and-index',
    expectAutomatable: true,
  },
  {
    label: 'Uploaded XLSX (Pricing.xlsx) — verified ingestible',
    input: { kind: 'FileUpload', file: { name: 'Pricing.xlsx', sizeBytes: 900_000 } },
    expectStrategy: 'copy-and-index',
    expectAutomatable: true,
  },
  {
    label: 'Uploaded file over 200 MB — fails size gate',
    input: { kind: 'FileUpload', file: { name: 'archive.pdf', sizeBytes: 260_000_000 } },
    expectStrategy: 'manual-review',
    expectAutomatable: false,
  },
  {
    label: 'Uploaded .msg — unsupported format',
    input: { kind: 'FileUpload', file: { name: 'thread.msg', sizeBytes: 50_000 } },
    expectStrategy: 'manual-review',
    expectAutomatable: false,
  },
  {
    label: 'SharePoint site reference — reconnect, needs identity federation',
    input: { kind: 'SharePointSource', references: ['https://contoso.sharepoint.com/sites/HR'] },
    expectStrategy: 'reconnect',
    expectAutomatable: false,
  },
  {
    label: 'OneDrive reference',
    input: { kind: 'OneDriveForBusiness', references: ['https://contoso-my.sharepoint.com/personal/x'] },
    expectStrategy: 'reconnect',
    expectAutomatable: false,
  },
  {
    label: 'Public website search (needs domain verification → not unattended)',
    input: { kind: 'PublicSiteSearch', references: ['https://company.com/help'] },
    expectStrategy: 'recreate',
    expectAutomatable: false,
  },
  {
    label: 'Azure Blob — needs credentials',
    input: { kind: 'AzureBlobStorage', references: ['https://acct.blob.core.windows.net/docs'] },
    expectStrategy: 'copy-and-index',
    expectAutomatable: false,
  },
  {
    label: 'Dataverse SENSITIVE table (account) — rebuild as live tool',
    input: { kind: 'DataverseQnA', references: ['account'] },
    expectStrategy: 'rebuild-as-tool',
    expectAutomatable: false,
  },
  {
    label: 'Dataverse REFERENCE table (Product) — snapshot into structured store',
    input: { kind: 'DataverseQnA', references: ['Product'] },
    expectStrategy: 'dataverse-snapshot',
    expectAutomatable: true,
  },
  {
    label: 'Dataverse REFERENCE table (Pricebook) — snapshot',
    input: { kind: 'Dataverse', references: ['Pricebook'] },
    expectStrategy: 'dataverse-snapshot',
    expectAutomatable: true,
  },
  {
    label: 'SQL database — rebuild as tool',
    input: { kind: 'SqlDatabase' },
    expectStrategy: 'rebuild-as-tool',
    expectAutomatable: false,
  },
  {
    label: 'Azure AI Search index — manual review',
    input: { kind: 'AzureAISearch' },
    expectStrategy: 'manual-review',
    expectAutomatable: false,
  },
  {
    label: 'Microsoft Graph connector — rebuild',
    input: { kind: 'GraphConnector' },
    expectStrategy: 'rebuild-as-tool',
    expectAutomatable: false,
  },
  {
    label: 'Unknown kind — manual review, never assumed migratable',
    input: { kind: 'SomeFutureThing' },
    expectStrategy: 'manual-review',
    expectAutomatable: false,
  },
  {
    label: 'Unknown kind BUT website URL ref (real dynamics365 case) → recreate, needs verification',
    input: { kind: 'AdvancedKnowledge', references: ['https://learn.microsoft.com/en-us/dynamics365'] },
    expectStrategy: 'recreate',
    expectAutomatable: false,
  },
  {
    label: 'Unknown kind BUT SharePoint URL ref → reconnect (inferred)',
    input: { kind: 'AdvancedKnowledge', references: ['https://contoso.sharepoint.com/sites/HR'] },
    expectStrategy: 'reconnect',
    expectAutomatable: false,
  },
];

let passed = 0;
let failed = 0;
const rows: string[] = [];

for (const c of cases) {
  const r = classifyKnowledgeSource(c.input);
  const ok = r.strategy === c.expectStrategy && r.automatable === c.expectAutomatable;
  if (ok) passed++;
  else failed++;
  rows.push(
    `${ok ? 'PASS' : 'FAIL'}  ${c.label}\n` +
      `        → strategy=${r.strategy} target=${r.geminiTarget} retrievability=${r.retrievability} automatable=${r.automatable}` +
      (ok ? '' : `\n        EXPECTED strategy=${c.expectStrategy} automatable=${c.expectAutomatable}`),
  );
}

// Direct unit checks on the format/size gate.
const gate = [
  { f: 'a.pdf', s: 1000, want: true },
  { f: 'a.xlsm', s: 1000, want: true },
  { f: 'a.zip', s: 1000, want: false },
  { f: 'noext', s: 1000, want: false },
  { f: 'big.pdf', s: 300_000_000, want: false },
];
for (const g of gate) {
  const r = checkFileCompatibility(g.f, g.s);
  const ok = r.compatible === g.want;
  if (ok) passed++;
  else failed++;
  rows.push(`${ok ? 'PASS' : 'FAIL'}  gate ${g.f} (${g.s}B) → compatible=${r.compatible}${r.reason ? ` (${r.reason})` : ''}`);
}

// ── Owner-domain heuristic: same strategy, different guidance ────────────────
const ownerCases = [
  { label: 'third-party site → Google Search grounding note', cls: classifyKnowledgeSource({ kind: 'PublicSiteSearch', references: ['https://learn.microsoft.com/dynamics365'], ownerDomains: ['storefuze.com'] }), wantOwned: false },
  { label: 'own domain → verify-ownership note', cls: classifyKnowledgeSource({ kind: 'PublicSiteSearch', references: ['https://storefuze.com/help'], ownerDomains: ['storefuze.com'] }), wantOwned: true },
  { label: 'own SUBdomain → verify-ownership note', cls: classifyKnowledgeSource({ kind: 'PublicSiteSearch', references: ['https://docs.storefuze.com/x'], ownerDomains: ['storefuze.com'] }), wantOwned: true },
];
for (const { label, cls, wantOwned } of ownerCases) {
  const note = cls.notes.join(' ');
  const isOwnedNote = /own domain|verify domain ownership/i.test(note);
  const ok = cls.strategy === 'recreate' && isOwnedNote === wantOwned;
  if (ok) passed++;
  else failed++;
  rows.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  ← ${note.slice(0, 90)}`}`);
}

// ── Three-state ownership verdict ───────────────────────────────────────────
const ownershipCases: { label: string; kind: string; refs: string[]; owners: string[]; want: string }[] = [
  { label: 'own domain → owned', kind: 'PublicSiteSearch', refs: ['https://storefuze.com/help'], owners: ['storefuze.com'], want: 'owned' },
  { label: 'known public site → third-party', kind: 'PublicSiteSearch', refs: ['https://learn.microsoft.com/x'], owners: ['storefuze.com'], want: 'third-party' },
  { label: 'unrecognized domain → unknown', kind: 'PublicSiteSearch', refs: ['https://partner.acme-corp.io/x'], owners: ['storefuze.com'], want: 'unknown' },
  { label: 'no owner domains discovered → unknown', kind: 'PublicSiteSearch', refs: ['https://storefuze.com/help'], owners: [], want: 'unknown' },
];
for (const c of ownershipCases) {
  const cls = classifyKnowledgeSource({ kind: c.kind, references: c.refs, ownerDomains: c.owners });
  const ok = cls.ownership === c.want;
  if (ok) passed++;
  else failed++;
  rows.push(`${ok ? 'PASS' : 'FAIL'}  ownership: ${c.label}${ok ? '' : `  ← got ${cls.ownership}`}`);
}

console.log(rows.join('\n'));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
