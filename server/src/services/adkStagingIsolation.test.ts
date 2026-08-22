import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deployReasoningEngine } from './adkDeployer.js';
import type { AdkSpec } from './adkDeployer.js';

/**
 * Every ADK deploy must stage its package to a directory of its own.
 *
 * The Vertex SDK defaults `gcs_dir_name` to the literal "agent_engine", so without an explicit
 * value every deploy in a project pickles its agent to the SAME object:
 *   gs://<bucket>/agent_engine/agent_engine.pkl
 * Two deploys in flight together overwrite each other and both containers get built from
 * whichever package landed last.
 *
 * This is not hypothetical. Live on 2026-08-21, "Hubspot agentt" (deploy started 11:47:32) and
 * "Email Manager" (11:47:50) produced two correctly-named engines created in the SAME second,
 * and BOTH answered with Email Manager's 16 Outlook tools — the HubSpot agent had none of its
 * own four. It was caught only because the two toolsets differed; two agents sharing a
 * connector would have swapped packages silently, and across tenants that is one customer's
 * agent running another customer's tools.
 *
 * The test drives the real `deployReasoningEngine`, substituting a fake worker that echoes the
 * argv it was handed, because the thing under test is the ARGUMENT the server passes — not
 * anything that needs Google.
 */
describe('ADK deploy staging isolation', () => {
  let dir: string;
  let fakeWorker: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'adk-staging-test-'));
    fakeWorker = join(dir, 'fake_worker.cjs');
    // Stands in for adk_deploy.py: prints the JSON line the deployer parses, with the argv it
    // received folded into the error string so the test can assert on it.
    writeFileSync(
      fakeWorker,
      'process.stdout.write(JSON.stringify({ error: "ARGV:" + JSON.stringify(process.argv.slice(2)) }) + "\\n");\n',
      'utf8',
    );
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const spec = (name: string): AdkSpec =>
    ({
      name,
      displayName: name,
      description: 'test',
      model: 'gemini-2.5-flash',
      instruction: 'test',
      tools: [],
    }) as AdkSpec;

  /** Run the real deployer against the fake worker and return the argv it passed. */
  async function argvFor(name: string): Promise<string[]> {
    const r = await deployReasoningEngine('proj', 'us-central1', spec(name), {
      pythonBin: process.execPath, // node runs the .cjs worker
      scriptPath: fakeWorker,
      timeoutMs: 30_000,
    });
    const m = /ARGV:(\[.*\])/.exec(r.error ?? '');
    expect(m, `worker did not report argv; got: ${r.error}`).toBeTruthy();
    return JSON.parse(m![1]) as string[];
  }

  it('passes an explicit --gcs-dir, so the SDK cannot fall back to the shared default', async () => {
    const argv = await argvFor('agent-one');
    expect(argv).toContain('--gcs-dir');
    const value = argv[argv.indexOf('--gcs-dir') + 1];
    expect(value, 'the flag must carry a value, not be a bare switch').toBeTruthy();
    expect(value).not.toBe('agent_engine');
  });

  it('gives two deploys of DIFFERENT agents different staging directories', async () => {
    const [a, b] = await Promise.all([argvFor('agent-one'), argvFor('agent-two')]);
    const dirA = a[a.indexOf('--gcs-dir') + 1];
    const dirB = b[b.indexOf('--gcs-dir') + 1];
    expect(dirA).not.toBe(dirB);
  });

  it('gives two deploys of the SAME agent different staging directories', async () => {
    // The collision is per-deploy, not per-agent: a retry, or the same agent re-migrated while
    // an earlier deploy is still packaging, must not reuse the earlier path either. Keying the
    // directory on the agent name alone would pass the test above and still corrupt this case.
    const [a, b] = await Promise.all([argvFor('same-agent'), argvFor('same-agent')]);
    const dirA = a[a.indexOf('--gcs-dir') + 1];
    const dirB = b[b.indexOf('--gcs-dir') + 1];
    expect(dirA).not.toBe(dirB);
  });

  it('retries once on a transport failure instead of downgrading to low-code', async () => {
    // A dropped connection says nothing about whether the spec is good, and the fallback is not
    // graceful: a low-code agent has no connector tools, no topic sub-agents, and cannot be
    // un-privated. Two of seven deploys on 2026-08-21/22 were lost to the network alone.
    const counter = join(dir, 'count.txt');
    const flaky = join(dir, 'flaky_worker.cjs');
    writeFileSync(
      flaky,
      // Fails the first call with a real transport error, succeeds on the second.
      `const fs=require('fs');const n=(fs.existsSync(${JSON.stringify(counter)})?+fs.readFileSync(${JSON.stringify(counter)},'utf8'):0)+1;` +
        `fs.writeFileSync(${JSON.stringify(counter)},String(n));` +
        `process.stdout.write(JSON.stringify(n===1` +
        `?{error:"deploy failed: ('Connection aborted.', ConnectionResetError(10054, 'forcibly closed'))"}` +
        `:{reasoningEngine:'projects/p/locations/l/reasoningEngines/999'})+'\\n');`,
      'utf8',
    );
    const r = await deployReasoningEngine('proj', 'us-central1', spec('flaky'), {
      pythonBin: process.execPath,
      scriptPath: flaky,
      timeoutMs: 30_000,
    });
    expect(r.ok, `expected the retry to succeed; got: ${r.error}`).toBe(true);
    expect(readFileSync(counter, 'utf8'), 'the worker should have been invoked twice').toBe('2');
  });

  it('does NOT retry a genuine deploy failure', async () => {
    // A bad spec, a quota refusal or an auth error fails identically twice, and re-staging the
    // package to GCS is expensive. Only transport is worth a second attempt.
    const counter = join(dir, 'count2.txt');
    const bad = join(dir, 'bad_worker.cjs');
    writeFileSync(
      bad,
      `const fs=require('fs');const n=(fs.existsSync(${JSON.stringify(counter)})?+fs.readFileSync(${JSON.stringify(counter)},'utf8'):0)+1;` +
        `fs.writeFileSync(${JSON.stringify(counter)},String(n));` +
        `process.stdout.write(JSON.stringify({error:'deploy failed: 400 INVALID_ARGUMENT bad spec'})+'\\n');`,
      'utf8',
    );
    const r = await deployReasoningEngine('proj', 'us-central1', spec('bad'), {
      pythonBin: process.execPath,
      scriptPath: bad,
      timeoutMs: 30_000,
    });
    expect(r.ok).toBe(false);
    expect(readFileSync(counter, 'utf8'), 'a real failure must not be retried').toBe('1');
  });

  it('keeps the directory inside the agent_engine prefix and free of path traversal', async () => {
    // The value becomes a GCS object prefix. A name arriving from a Copilot display name must
    // not be able to steer where the package lands.
    const argv = await argvFor('../../etc/passwd Weird Name!');
    const value = argv[argv.indexOf('--gcs-dir') + 1];
    expect(value.startsWith('agent_engine/')).toBe(true);
    expect(value).not.toContain('..');
  });
});
