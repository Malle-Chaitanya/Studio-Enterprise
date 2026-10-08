import type { Config } from './config.js';
import type { SprintBoardClient } from './sprintboardClient.js';
import type { StateStore } from './stateStore.js';
import type { Issue } from './types.js';
import { matchesProject } from './scopeFilter.js';
import { classifyWorkflow } from './workflowClassifier.js';
import { runClaudeFix } from './claudeRunner.js';
import { typecheckAndTest, createBranchCommitPush, openPullRequest, hasUncommittedChanges } from './gitOps.js';

function buildPrompt(issue: Issue, path: 'full' | 'fast'): string {
  const instructions =
    path === 'full'
      ? "This is a substantial change (epic/story, or touches schema/architecture). Start with gstack /autoplan to design the approach before implementing."
      : "This is a routine change. Skip Spec/Plan and implement directly, following this repo's CLAUDE.md and code-style rules.";

  return [
    `You are fixing SprintBoard ticket ${issue.key}: ${issue.title}`,
    issue.description ? `Description: ${issue.description}` : '',
    instructions,
    "This repo's CLAUDE.md skill-routing menu normally waits for a human to choose gstack vs. plain approach - there is no human in this session, so apply the instruction above instead of waiting.",
    'Do not merge or deploy anything, and do not push directly to main or business. Stop once the change is implemented and typecheck/tests pass locally - a separate process handles branching, committing, and opening the PR.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

async function handleBlocked(
  client: SprintBoardClient,
  state: StateStore,
  issue: Issue,
  reason: string,
): Promise<void> {
  await client.updateIssue(issue.id, { status: 'Blocked' });
  await client.postComment(issue.id, `Automated fix attempt stopped:\n\n${reason}`);
  await state.set(issue.id, { phase: 'blocked', reason, finishedAt: new Date().toISOString() });
  console.error(`[ticket-agent] ${issue.key} blocked: ${reason}`);
}

export async function runTick(config: Config, client: SprintBoardClient, state: StateStore): Promise<void> {
  const issues = await client.getMyIssues();
  const known = await state.load();

  const pending = issues.filter(
    (issue) =>
      issue.assignee_id === config.userId &&
      issue.status === 'To Do' &&
      matchesProject(issue) &&
      !known[issue.id],
  );

  for (const issue of pending) {
    console.log(`[ticket-agent] picking up ${issue.key}: ${issue.title}`);
    await state.set(issue.id, { phase: 'in_progress', startedAt: new Date().toISOString() });

    const workflowPath = classifyWorkflow(issue);
    const prompt = buildPrompt(issue, workflowPath);

    const result = await runClaudeFix(prompt, config.repoPath, config.claudeSkipPermissions);
    if (result.exitCode !== 0) {
      await handleBlocked(
        client,
        state,
        issue,
        `Claude session exited with code ${result.exitCode}.\n\n${result.stderr.slice(-2000)}`,
      );
      continue;
    }

    const verification = await typecheckAndTest(config.repoPath);
    if (!verification.passed) {
      await handleBlocked(
        client,
        state,
        issue,
        `Typecheck/tests failed after the fix attempt:\n\n${verification.output.slice(-2000)}`,
      );
      continue;
    }

    if (!(await hasUncommittedChanges(config.repoPath))) {
      // Not a failure - the ticket turned out to need no code change (a
      // research ask already answered, a duplicate, etc). Post Claude's own
      // explanation instead of letting a doomed `git commit` bury it under a
      // generic "nothing to commit" error.
      await client.updateIssue(issue.id, { status: 'Done', fix_description: result.stdout.slice(-2000) });
      await client.postComment(issue.id, `No code change needed:\n\n${result.stdout.slice(-2000)}`);
      await state.set(issue.id, { phase: 'no_change_needed', finishedAt: new Date().toISOString() });
      console.log(`[ticket-agent] ${issue.key}: no change needed`);
      continue;
    }

    const branch = `agent/${issue.key.toLowerCase()}-fix`;
    const commitMessage = `${issue.key}: ${issue.title}\n\nAutomated fix by ticket-agent.`;

    try {
      await createBranchCommitPush(config.repoPath, config.prBaseBranch, branch, commitMessage);
      const prUrl = await openPullRequest(
        config.repoPath,
        branch,
        config.prBaseBranch,
        `${issue.key}: ${issue.title}`,
        `Automated fix for ${issue.key}.\n\nSprintBoard: ${config.sprintboardBaseUrl}/?issue=${issue.key}`,
      );

      await client.updateIssue(issue.id, {
        status: 'In Review',
        fix_description: result.stdout.slice(-2000),
      });
      await client.postComment(issue.id, `Automated fix opened: ${prUrl}`);
      await state.set(issue.id, { phase: 'done', prUrl, branch, finishedAt: new Date().toISOString() });
      console.log(`[ticket-agent] ${issue.key} -> ${prUrl}`);
    } catch (error) {
      await handleBlocked(client, state, issue, `Git/PR step failed: ${(error as Error).message}`);
    }
  }
}
