import { existsSync } from 'node:fs';

const files = [
  'scripts/connector_tools/gmail.py',
  'scripts/connector_tools/contacts.py',
  'scripts/connector_tools/calendar.py',
  'scripts/connector_tools/google_drive.py', // must still exist
];
for (const f of files) {
  console.log(f, existsSync(f) ? 'EXISTS' : 'GONE');
}
