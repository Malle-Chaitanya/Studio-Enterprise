import { loadConfig } from './config.js';
import { SprintBoardClient } from './sprintboardClient.js';
import { StateStore, defaultStatePath } from './stateStore.js';
import { runTick } from './poller.js';

// Single-pass entry point for a supervised dry run: runs exactly one tick
// (real side effects - spawns Claude, may open a PR, may write to
// SprintBoard) and exits, instead of index.ts's infinite poll loop.
async function main(): Promise<void> {
  const config = loadConfig();
  const client = new SprintBoardClient(config);
  const state = new StateStore(defaultStatePath(import.meta.url));

  console.log(`[ticket-agent] running a single tick against ${config.repoPath}`);
  await runTick(config, client, state);
  console.log('[ticket-agent] tick complete.');
}

main();
