/**
 * Put a deployed agent through a fixed battery and report STRUCTURAL evidence per question.
 *
 * The last question is a negative control: it names a file that does not exist on a connector
 * that was deliberately NOT wired. A confident answer there is a hallucination, which matters
 * more than any of the passes above it.
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { chatWithAdkAgent } from '../services/adkAgentChat.js';
import { config } from '../config.js';

const ENGINE = process.argv[2];
const QUESTIONS: Array<[string, string]> = [
  ['Teams', 'Use your Teams tools. List every Team I am a member of, then list the channels in the first one. Give me the exact names.'],
  ['HubSpot', 'Use your HubSpot tools. List the companies and the deals in the CRM, with their names and deal amounts.'],
  ['Jira deep', 'Use jira_search to find open issues in the CloudFuze project. Give me issue keys, summaries and who they are assigned to.'],
  ['Confluence page', 'Find a Confluence page about migration and use confluence_get_page to return its actual content. Include the page URL.'],
  ['NEGATIVE CONTROL', 'Read the file /Reports/Q3-revenue.xlsx from Google Drive and tell me the total revenue.'],
];

const token = await getSaToken();
const project = config.GEMINI_PROJECT_FALLBACK || process.env.GEMINI_PROJECT || '';
for (const [label, q] of QUESTIONS) {
  const r = await chatWithAdkAgent(project, token, {
    reasoningEngineId: ENGINE, message: q, userId: 'battery@cloudfuze.com',
  });
  console.log('\n' + '='.repeat(70));
  console.log(`[${label}]`);
  console.log('ok=', r.ok, '| toolCalled=', r.toolCalled, '| toolSucceeded=', r.toolSucceeded);
  console.log('tools invoked:', (r.toolNames ?? []).join(', ') || '(none)');
  if (r.toolError) console.log('TOOL ERROR:', r.toolError);
  if (r.error) console.log('ERROR:', r.error);
  console.log('---');
  console.log((r.answer ?? '').slice(0, 1100));
}
process.exit(0);
