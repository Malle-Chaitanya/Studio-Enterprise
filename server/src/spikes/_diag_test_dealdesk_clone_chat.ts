import 'dotenv/config';
import { spawn } from 'node:child_process';

const scriptPath =
  'C:/Users/CHAITA~1/AppData/Local/Temp/claude/C--Users-ChaitanyaMalle-Studio-Enterprise-Studio-Enterprise/7eaf578d-2a60-4833-b053-46ce29431472/scratchpad/test_dealdesk_clone_conversation.py';

const child = spawn('python', [scriptPath], { env: process.env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
