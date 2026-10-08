import { loadConfig } from './config.js';
import { SprintBoardClient } from './sprintboardClient.js';
import { StateStore, defaultStatePath } from './stateStore.js';
import { matchesProject } from './scopeFilter.js';
import { classifyWorkflow } from './workflowClassifier.js';

// Read-only: fetches + filters exactly like the poller does, but never
// spawns Claude, never touches git/GitHub, never writes to SprintBoard.
// Safe to run any time to see what the next real tick would pick up.
async function main(): Promise<void> {
  const config = loadConfig();
  const client = new SprintBoardClient(config);
  const state = new StateStore(defaultStatePath(import.meta.url));

  const issues = await client.getMyIssues();
  const known = await state.load();

  const candidates = issues.filter(
    (issue) => issue.assignee_id === config.userId && issue.status === 'To Do',
  );
  const matching = candidates.filter((issue) => matchesProject(issue));
  const pending = matching.filter((issue) => !known[issue.id]);

  console.log(`Assigned to you, status "To Do": ${candidates.length}`);
  console.log(`  of those, match CS_GE keywords: ${matching.length}`);
  console.log(`  of those, not already processed: ${pending.length}\n`);

  for (const issue of pending) {
    console.log(`${issue.key} [${classifyWorkflow(issue)}] - ${issue.title}`);
  }
  if (pending.length === 0) {
    console.log('Nothing would trigger on the next real tick.');
  }
}

main();
