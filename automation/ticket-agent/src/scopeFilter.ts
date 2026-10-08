// SprintBoard's "Agents Team" board spans multiple unrelated products (DLP,
// connectors, server monitors, etc). There's no dedicated field for "this
// ticket is CS_GE work", so we match on keywords in title/description.
const PROJECT_KEYWORDS = [
  'copilot studio',
  'gemini enterprise',
  'cs_ge',
  'agentir',
  'studio migrate',
];

export function matchesProject(issue: { title: string; description: string | null }): boolean {
  const haystack = `${issue.title} ${issue.description ?? ''}`.toLowerCase();
  return PROJECT_KEYWORDS.some((keyword) => haystack.includes(keyword));
}
