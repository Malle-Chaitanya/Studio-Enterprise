/**
 * Fixture test for the Dataverse-snapshot transform.
 * Run: cd server && npx tsx src/_test_snapshot.ts
 */
import { rowsToStructuredDocs, toJsonl, findDuplicateIds } from './services/dataverseSnapshot.js';

let passed = 0;
let failed = 0;
const log: string[] = [];
function check(name: string, cond: boolean, detail = '') {
  if (cond) passed++;
  else failed++;
  log.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  ← ${detail}`}`);
}

const rows = [
  {
    productid: 'a1b2',
    'productid@OData.Community.Display.V1.FormattedValue': 'ignore me',
    name: 'Laptop',
    price: 1200,
    category: 'Electronics',
    internalNotes: 'do not index',
    '@odata.etag': 'W/"123"',
    _ownerid_value: 'someguid',
    createdon: '2026-01-01',
    statecode: 0,
  },
  { productid: 'c3d4', name: 'Mouse', price: 25, category: 'Accessories', internalNotes: 'x' },
];

const docs = rowsToStructuredDocs({
  table: 'Product',
  rows,
  primaryKey: 'productid',
  excludeColumns: ['internalNotes'],
  snapshotAt: '2026-07-21T00:00:00Z',
  sourceRef: 'Dataverse:CloudFuze Migration Test/Product',
});

check('one doc per row', docs.length === 2, String(docs.length));
check('stable id from primary key', docs[0].id === 'a1b2', docs[0].id);
check('business fields kept', docs[0].structData.name === 'Laptop' && docs[0].structData.price === 1200);
check('excluded column dropped', !('internalNotes' in docs[0].structData));
check('@odata plumbing dropped', !Object.keys(docs[0].structData).some((k) => k.includes('@odata')));
check('FormattedValue column dropped', !Object.keys(docs[0].structData).some((k) => k.includes('FormattedValue')));
check('_ownerid_value system col dropped', !('_ownerid_value' in docs[0].structData));
check('createdon/statecode system cols dropped', !('createdon' in docs[0].structData) && !('statecode' in docs[0].structData));
check('provenance stamped', docs[0].structData._source === 'Dataverse:CloudFuze Migration Test/Product');
check('staleness timestamp stamped', docs[0].structData._snapshotAt === '2026-07-21T00:00:00Z');

// Idempotency: same rows → same ids (re-run updates, not duplicates).
const docs2 = rowsToStructuredDocs({ table: 'Product', rows, primaryKey: 'productid', snapshotAt: 'x', sourceRef: 'y' });
check('ids stable across runs (idempotent refresh)', docs.every((d, i) => d.id === docs2[i].id));
check('no duplicate ids for distinct keys', findDuplicateIds(docs).length === 0);

// JSONL output
const jsonl = toJsonl(docs);
const lines = jsonl.split('\n');
check('JSONL: one line per doc', lines.length === 2);
check('JSONL: each line parses & has id+structData', lines.every((l) => {
  const o = JSON.parse(l);
  return typeof o.id === 'string' && o.structData && typeof o.structData === 'object';
}));

// Duplicate detection when keys collide
const dupeDocs = rowsToStructuredDocs({
  table: 'T', rows: [{ k: 'same', v: 1 }, { k: 'same', v: 2 }], primaryKey: 'k', snapshotAt: 'x', sourceRef: 'y',
});
check('duplicate ids detected', findDuplicateIds(dupeDocs).length === 1, JSON.stringify(findDuplicateIds(dupeDocs)));

// Missing primary key → positional fallback, nothing dropped
const noPk = rowsToStructuredDocs({ table: 'T', rows: [{ v: 1 }], primaryKey: 'k', snapshotAt: 'x', sourceRef: 'y' });
check('missing PK → positional id, row kept', noPk.length === 1 && noPk[0].id === 'T-row-0', noPk[0]?.id);

console.log(log.join('\n'));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
