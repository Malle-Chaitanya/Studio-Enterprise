import { classifyKnowledgeSource } from '../services/knowledgeClassifier.js';

const result = classifyKnowledgeSource({
  kind: 'PublicSiteSearchSource',
  references: ['https://learn.microsoft.com/en-us/microsoft-copilot-studio/'],
});
console.log(JSON.stringify(result, null, 2));
