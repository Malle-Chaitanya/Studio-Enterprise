/** Spawn the standalone Python deploy script for a throwaway "Deal Desk - TEST CLONE"
 *  ADK agent, reusing this app's already-loaded .env (via dotenv/config) as the
 *  child process's environment -- same pattern adkDeployer.ts uses to invoke
 *  scripts/adk_deploy.py. Never reads .env directly. THIS CREATES A REAL, BILLABLE
 *  Vertex AI Reasoning Engine. npx tsx src/spikes/_diag_deploy_dealdesk_test_clone.ts */
import 'dotenv/config';
import { spawn } from 'node:child_process';

const scriptPath =
  'C:/Users/CHAITA~1/AppData/Local/Temp/claude/C--Users-ChaitanyaMalle-Studio-Enterprise-Studio-Enterprise/7eaf578d-2a60-4833-b053-46ce29431472/scratchpad/deploy_dealdesk_test_clone.py';

const child = spawn('python', [scriptPath], { env: process.env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
