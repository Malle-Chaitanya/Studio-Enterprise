import type { Issue } from './types.js';

// Mirrors the full-pipeline vs. fast-path skip conditions already documented
// in this repo's .claude/rules/aisdlc.md - reusing that rule rather than
// inventing a separate one.
const FULL_PIPELINE_KEYWORDS = [
  'schema',
  'agentir',
  'architecture',
  'migration engine',
  'new integration',
  'breaking change',
];

export type WorkflowPath = 'full' | 'fast';

export function classifyWorkflow(issue: Pick<Issue, 'type' | 'title' | 'description'>): WorkflowPath {
  if (issue.type === 'epic' || issue.type === 'story') return 'full';
  const haystack = `${issue.title} ${issue.description ?? ''}`.toLowerCase();
  if (FULL_PIPELINE_KEYWORDS.some((keyword) => haystack.includes(keyword))) return 'full';
  return 'fast';
}
