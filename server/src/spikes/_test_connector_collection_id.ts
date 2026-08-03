/** Verifies connectorCollectionId stays under Google's documented 63-char
 *  dataStoreId limit (with headroom for whatever suffix Google appends
 *  internally) and never collides for different sites sharing a long common
 *  prefix — the exact live bug found against filefuze's real data.
 *   npx tsx src/spikes/_test_connector_collection_id.ts */
import { connectorCollectionId } from '../services/knowledgePlanner.js';

const sites = [
  'https://filefuze.sharepoint.com/Shared%20Documents/TestingPermissions',
  'https://filefuze.sharepoint.com/sites/Teston/ganesh/SOUMYATEST01',
  'https://filefuze.sharepoint.com/sites/ITHelpDeskKnowledge/Shared%20Documents/Rollbar.docx',
  'https://filefuze.sharepoint.com/sites/ITHelpDeskKnowledge/Shared%20Documents/BAMBOO%20HR.docx',
  'https://filefuze.sharepoint.com/Shared%20Documents',
];

const ids = sites.map((s) => connectorCollectionId('filefuze', s));
ids.forEach((id, i) => console.log(`${id.length}\t${id}\t<- ${sites[i]}`));

const allUnder58 = ids.every((id) => id.length <= 58);
const allUnique = new Set(ids).size === ids.length;
console.log(`\nPASS=${allUnder58} — all under 58 chars (63-limit minus headroom)`);
console.log(`PASS=${allUnique} — all unique (no collisions across different sites)`);
process.exit(allUnder58 && allUnique ? 0 : 1);
