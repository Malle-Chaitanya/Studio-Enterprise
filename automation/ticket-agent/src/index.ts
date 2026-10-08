import { loadConfig } from './config.js';
import { SprintBoardClient } from './sprintboardClient.js';
import { StateStore, defaultStatePath } from './stateStore.js';
import { runTick } from './poller.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new SprintBoardClient(config);
  const state = new StateStore(defaultStatePath(import.meta.url));

  console.log(`[ticket-agent] starting, polling every ${config.pollIntervalMs}ms against ${config.repoPath}`);

  for (;;) {
    try {
      await runTick(config, client, state);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/\b401\b|Unauthorized/.test(message)) {
        console.error(
          '[ticket-agent] SprintBoard token appears to have expired. Re-login in the browser, grab the new bearer token, update SPRINTBOARD_TOKEN in .env, then restart this process.',
        );
      } else {
        console.error('[ticket-agent] tick failed:', message);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
}

main();
