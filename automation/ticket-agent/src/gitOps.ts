import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function run(cmd: string, args: string[], cwd: string, extraEnv?: Record<string, string>): Promise<string> {
  // Only npm needs a shell on Windows (it resolves to npm.cmd, a batch file
  // that CreateProcess can't launch directly). git/gh are real .exe binaries
  // and must NOT go through cmd.exe: Node's shell:true does not quote array
  // args for you on Windows, so any space/colon in an arg (a commit message,
  // a PR title/body) gets re-split by cmd.exe into separate positional args -
  // that's what turned a commit message into a dozen bogus pathspecs.
  const needsShell = process.platform === 'win32' && cmd === 'npm';
  const { stdout } = await execFileAsync(cmd, args, {
    cwd,
    shell: needsShell,
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
  return stdout.trim();
}

export interface VerificationResult {
  passed: boolean;
  output: string;
}

// config.ts Zod-parses process.env at import time and process.exit(1)s on a
// missing value, which kills every suite that transitively imports logger or
// db/core before its first assertion. Same placeholders deploy.yml's CI job
// uses - never used to reach a real service.
const TEST_ENV = {
  MS_CLIENT_ID: 'ci-placeholder',
  MS_CLIENT_SECRET: 'ci-placeholder',
  GOOGLE_CLIENT_ID: 'ci-placeholder',
  GOOGLE_CLIENT_SECRET: 'ci-placeholder',
};

export async function typecheckAndTest(repoPath: string): Promise<VerificationResult> {
  try {
    const serverCheck = await run('npm', ['run', 'typecheck'], `${repoPath}/server`);
    const serverTest = await run('npm', ['test'], `${repoPath}/server`, TEST_ENV);
    const webCheck = await run('npm', ['run', 'typecheck'], `${repoPath}/web`);
    return { passed: true, output: [serverCheck, serverTest, webCheck].join('\n') };
  } catch (error) {
    return { passed: false, output: (error as Error).message };
  }
}

// A ticket can legitimately need no code change (e.g. a research ask that
// turns out to already be answered) - `git commit` on an empty diff is not a
// failure to route through handleBlocked, it's a different outcome entirely.
export async function hasUncommittedChanges(repoPath: string): Promise<boolean> {
  const status = await run('git', ['status', '--porcelain'], repoPath);
  return status.length > 0;
}

export async function createBranchCommitPush(
  repoPath: string,
  baseBranch: string,
  branch: string,
  commitMessage: string,
): Promise<void> {
  // Can't `git checkout <baseBranch>` here - that branch name is already
  // checked out in the operator's own interactive worktree, and git refuses
  // to have the same branch checked out in two worktrees at once. Instead,
  // reset this worktree's own local branch to match the remote tip.
  // -B (not -b): a prior attempt for the same ticket can leave this branch
  // behind (e.g. checkout succeeded, a later commit/push step failed) - force
  // it back onto the fresh base rather than erroring that it already exists.
  await run('git', ['fetch', 'origin', baseBranch], repoPath);
  await run('git', ['checkout', '-B', 'agent-base', `origin/${baseBranch}`], repoPath);
  await run('git', ['checkout', '-B', branch], repoPath);
  await run('git', ['add', '-A'], repoPath);
  await run('git', ['commit', '-m', commitMessage], repoPath);
  await run('git', ['push', '-u', 'origin', branch], repoPath);
}

export async function openPullRequest(
  repoPath: string,
  branch: string,
  base: string,
  title: string,
  body: string,
): Promise<string> {
  return run('gh', ['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body', body], repoPath);
}
