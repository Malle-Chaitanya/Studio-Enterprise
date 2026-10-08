export interface Config {
  sprintboardBaseUrl: string;
  sprintboardToken: string;
  spaceId: string;
  userId: string;
  repoPath: string;
  pollIntervalMs: number;
  prBaseBranch: string;
  claudeSkipPermissions: boolean;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

export function loadConfig(): Config {
  try {
    process.loadEnvFile();
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || (error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    // no .env file - fall through to requireEnv's error, which names what's missing
  }

  return {
    sprintboardBaseUrl: process.env.SPRINTBOARD_BASE_URL ?? 'https://sprintboard.cftools.live',
    sprintboardToken: requireEnv('SPRINTBOARD_TOKEN'),
    spaceId: requireEnv('SPRINTBOARD_SPACE_ID'),
    userId: requireEnv('SPRINTBOARD_USER_ID'),
    repoPath: requireEnv('REPO_PATH'),
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 300_000),
    prBaseBranch: process.env.PR_BASE_BRANCH ?? 'main',
    claudeSkipPermissions: process.env.CLAUDE_SKIP_PERMISSIONS === '1',
  };
}
