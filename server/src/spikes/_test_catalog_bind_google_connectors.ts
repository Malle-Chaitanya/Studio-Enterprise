/**
 * Proves the Google connector catalog actually resolves real Copilot Studio operation ids
 * into correct, callable Google API requests — same proof shape as
 * _test_catalog_bind_office365users.ts, across all six connectors seeded by
 * _prep_seed_google_connectors_catalog.ts.
 *
 * Run AFTER that seed script:
 *   npx tsx src/spikes/_prep_seed_google_connectors_catalog.ts
 *   npx tsx src/spikes/_test_catalog_bind_google_connectors.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { bindFromCatalog } from '../connectors/catalogBinding.js';

await connectMongo();

const CASES: Array<[string, string]> = [
  // Google Drive
  ['shared_googledrive', 'CopyFile'],
  ['shared_googledrive', 'CreateFileV2'], // expect unsupported (binary content)
  ['shared_googledrive', 'DeleteFile'],
  ['shared_googledrive', 'ExtractFolderV2'], // expect unsupported (no single API call)
  ['shared_googledrive', 'GetFileContent'],
  ['shared_googledrive', 'GetFileContentByPath'], // expect unsupported (two-step)
  ['shared_googledrive', 'GetFileMetadata'],
  ['shared_googledrive', 'GetFileMetadataByPath'], // expect unsupported (two-step)
  ['shared_googledrive', 'ListFolder'],
  ['shared_googledrive', 'ListRootFolder'],
  ['shared_googledrive', 'UpdateFile'], // expect unsupported (binary content)
  // Google Sheets
  ['shared_googlesheet', 'GetTables'],
  ['shared_googlesheet', 'GetItems'],
  ['shared_googlesheet', 'GetItem'],
  ['shared_googlesheet', 'PostItem'],
  ['shared_googlesheet', 'PatchItem'],
  ['shared_googlesheet', 'DeleteItem'],
  // Google Contacts
  ['shared_googlecontacts', 'PeopleApiCreateContactV2'],
  ['shared_googlecontacts', 'PeopleApiCreateContactV3'],
  ['shared_googlecontacts', 'PeopleApiListContactsV4'],
  // Google Calendar
  ['shared_googlecalendar', 'CreateEvent'],
  ['shared_googlecalendar', 'GetEvent'],
  ['shared_googlecalendar', 'DeleteEvent'],
  ['shared_googlecalendar', 'ListCalendars'],
  ['shared_googlecalendar', 'ListEvents'],
  ['shared_googlecalendar', 'UpdateEvent'],
  // Google Tasks
  ['shared_googletasks', 'CraeteTask'], // real id, not a typo — see seed script comment
  ['shared_googletasks', 'CreateTaskList'],
  ['shared_googletasks', 'ListTask'],
  ['shared_googletasks', 'ListTaskLists'],
  ['shared_googletasks', 'ListTasks'],
  // Gmail
  ['shared_gmail', 'DeleteEmail'],
  ['shared_gmail', 'GetEmail'],
  ['shared_gmail', 'TrashEmail'],
  ['shared_gmail', 'SearchEmails'],
  ['shared_gmail', 'SendEmailV2'],
  ['shared_gmail', 'ReplyToV2'], // expect unsupported (needs threading, two-step)
  // Never-cataloged control case
  ['shared_googledrive', 'SomethingNeverCataloged'],
];

let bindable = 0;
let unsupported = 0;
let notInCatalog = 0;

for (const [connectorId, sourceOperationId] of CASES) {
  const result = await bindFromCatalog(connectorId, sourceOperationId);
  console.log(`\n${connectorId} :: ${sourceOperationId}`);
  if (result.status === 'bindable') {
    bindable++;
    console.log('  BINDABLE');
    console.log(`  ${result.operation.method} ${result.operation.urlTemplate}`);
    console.log(`  auth: ${result.operation.auth}`);
    console.log(
      `  parameters: ${
        result.operation.parameters
          .map((p) => `${p.name}(${p.in}${p.required ? ', required' : ''})`)
          .join(', ') || 'none'
      }`,
    );
  } else if (result.status === 'unsupported') {
    unsupported++;
    console.log(`  UNSUPPORTED: ${result.reason}`);
  } else {
    notInCatalog++;
    console.log('  NOT IN CATALOG');
  }
}

console.log(`\n\nTotals: ${bindable} bindable, ${unsupported} unsupported, ${notInCatalog} not-in-catalog.`);
process.exit(0);
