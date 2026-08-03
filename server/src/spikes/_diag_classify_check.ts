/** One-off: verify classifier output for the real-world kind tokens found in the live tenant. */
import { classifyKnowledgeSource } from '../services/knowledgeClassifier.js';

const cases = [
  { kind: 'PublicSiteSearchSource', references: ['https://www.whois.com'] },
  { kind: 'SharePointKnowledgeSource', references: ['https://filefuze.sharepoint.com/Shared%20Documents/TestingPermissions'] },
  { kind: 'SharePointSearchSource', references: ['https://filefuze.sharepoint.com/sites/ITHelpDeskKnowledge/Shared%20Documents/Rollbar.docx'] },
  { kind: 'DataverseStructuredSearchSource', references: ['SalesSpecificQnA'] },
  { kind: 'FederatedStructuredSearchSource', references: ['vvdocx_YQfh2eBbMADnjFCIY2jKV'] },
];
for (const c of cases) {
  const r = classifyKnowledgeSource(c);
  console.log(c.kind, '->', r.strategy, '/', r.geminiTarget, '/ automatable=', r.automatable);
}
