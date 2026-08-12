/** Full resource for one agent, to see what the console would filter on. Read-only. */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';
const PROJECT = 'studio-enterprise-migration';
const ID = process.argv[2]!;
const saToken = await getSaToken();
const dest = await resolveDestination(PROJECT, saToken);
const url =
  `https://discoveryengine.googleapis.com/v1alpha/projects/${dest.project}/locations/global` +
  `/collections/default_collection/engines/${dest.engine}/assistants/${dest.assistant}/agents/${ID}`;
const res = await fetch(url, { headers: { Authorization: `Bearer ${saToken}` } });
console.log(res.status);
const j = JSON.parse(await res.text());
// Drop the bulky instruction so the interesting metadata is readable.
if (j.adkAgentDefinition?.toolSettings) j.adkAgentDefinition.toolSettings = '(omitted)';
console.log(JSON.stringify(j, null, 2).slice(0, 2500));
process.exit(0);
