import { spawn } from 'node:child_process';

export interface ClaudeRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// UNVERIFIED IN THIS SESSION: confirm `claude -p "<prompt>"` behaves as
// expected against your installed CLI version (e.g. `claude -p "say hi"`)
// before wiring this into the unattended loop.
//
// `skipPermissions` defaults to false and is only ever true if the operator
// set CLAUDE_SKIP_PERMISSIONS=1 themselves (see config.ts) - this file never
// decides that on its own.
// The prompt goes over stdin, never argv. Passing a multi-line prompt as a
// CLI arg goes through cmd.exe on Windows (shell:true, needed to resolve the
// `claude` npm shim there), which does not quote/escape array args - spaces,
// colons and embedded newlines get re-split into garbage, and `claude` fell
// back to its own "no stdin data received... Ready. What task?" prompt and
// exited 0 having done nothing. The CLI already supports reading -p's prompt
// from stdin (that fallback message is its own), so use that path instead.
export function runClaudeFix(prompt: string, cwd: string, skipPermissions: boolean): Promise<ClaudeRunResult> {
  const args = ['-p'];
  if (skipPermissions) args.push('--dangerously-skip-permissions');

  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, {
      cwd,
      shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    // Stream live, not just capture - a silent multi-minute subprocess with
    // no visible output is undebuggable when something goes wrong.
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      process.stderr.write(chunk);
    });

    child.on('error', reject);
    child.on('close', (exitCode) => {
      resolve({ stdout, stderr, exitCode: exitCode ?? 1 });
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}
