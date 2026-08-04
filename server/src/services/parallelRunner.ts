/**
 * Parallel run — triggers both PA flow and GCP Workflow with the same input,
 * waits for both, then compares outputs to verify correctness.
 *
 * Strategy:
 *   1. Manually trigger the GCP Workflow execution with test args
 *   2. The PA flow is triggered separately (customer runs it in PA portal or
 *      we trigger via PA Management API if we have delegated perms)
 *   3. Compare what each wrote to Dataverse (or HTTP response)
 *
 * For Phase 1: we trigger GCP Workflow and verify it executes without error.
 * Full PA↔GCP output comparison is wired in Phase 2 once we have PA run logs.
 */

import { logger } from '../logger.js';
import type { WorkflowFlowDoc } from '../db/repos/workflowFlows.js';

export interface ParallelRunResult {
  gcpSuccess: boolean;
  gcpOutput: unknown;
  gcpError: string | null;
  gcpExecutionId: string | null;

  paTriggered: boolean;    // whether we were able to trigger PA side
  paOutput: unknown | null;
  paError: string | null;

  outputsMatch: boolean | null;  // null = couldn't compare
  matchDetails: string;          // human-readable explanation
}

export interface ParallelRunOptions {
  projectId: string;
  region: string;
  gcpAccessToken: string;
  workflowName: string;
  testArgs?: Record<string, unknown>;
  // PA trigger (optional — if we have PA Management API access)
  paOrgUrl?: string;
  paMsToken?: string;
  paWorkflowId?: string;
}

/**
 * Run GCP Workflow and (if PA creds available) PA flow simultaneously.
 * Compare outputs and return match result.
 */
export async function runParallel(opts: ParallelRunOptions): Promise<ParallelRunResult> {
  const { projectId, region, gcpAccessToken, workflowName, testArgs = {} } = opts;

  // Trigger GCP Workflow
  const gcpPromise = triggerGcpWorkflow(projectId, region, gcpAccessToken, workflowName, testArgs);

  // Trigger PA flow if we have creds (best-effort, non-blocking)
  const paPromise = opts.paOrgUrl && opts.paMsToken && opts.paWorkflowId
    ? triggerPaFlow(opts.paOrgUrl, opts.paMsToken, opts.paWorkflowId, testArgs)
    : Promise.resolve({ triggered: false, output: null, error: 'PA trigger not configured' });

  const [gcpResult, paResult] = await Promise.allSettled([gcpPromise, paPromise]);

  const gcp = gcpResult.status === 'fulfilled'
    ? gcpResult.value
    : { success: false, output: null, error: String(gcpResult.reason), executionId: null };

  const pa = paResult.status === 'fulfilled'
    ? paResult.value
    : { triggered: false, output: null, error: String(paResult.reason) };

  // Compare outputs
  const comparison = compareOutputs(gcp.output, pa.output, pa.triggered);

  return {
    gcpSuccess: gcp.success,
    gcpOutput: gcp.output,
    gcpError: gcp.error,
    gcpExecutionId: gcp.executionId,
    paTriggered: pa.triggered,
    paOutput: pa.output,
    paError: pa.error ?? null,
    outputsMatch: comparison.match,
    matchDetails: comparison.details,
  };
}

// ── GCP Workflow trigger ──────────────────────────────────────────────────────

async function triggerGcpWorkflow(
  projectId: string,
  region: string,
  accessToken: string,
  workflowName: string,
  args: Record<string, unknown>,
): Promise<{ success: boolean; output: unknown; error: string | null; executionId: string | null }> {
  const baseUrl = `https://workflowexecutions.googleapis.com/v1`;
  const parent = `projects/${projectId}/locations/${region}/workflows/${workflowName}`;

  // Create execution
  const createRes = await fetch(`${baseUrl}/${parent}/executions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ argument: JSON.stringify(args) }),
  });

  if (!createRes.ok) {
    const body = await createRes.text();
    return { success: false, output: null, error: `Create execution failed: ${createRes.status} ${body}`, executionId: null };
  }

  const execution = await createRes.json() as { name: string };
  const executionId = execution.name;

  // Poll until complete (max 120s)
  const maxAttempts = 60;
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(2000);

    const pollRes = await fetch(`${baseUrl}/${executionId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!pollRes.ok) continue;

    const status = await pollRes.json() as {
      state: string;
      result?: string;
      error?: { payload: string; context: string };
    };

    if (status.state === 'SUCCEEDED') {
      let output: unknown = status.result;
      try { output = JSON.parse(status.result ?? '{}'); } catch {}
      return { success: true, output, error: null, executionId };
    }

    if (status.state === 'FAILED' || status.state === 'CANCELLED') {
      const errMsg = status.error?.payload ?? status.error?.context ?? 'Execution failed';
      return { success: false, output: null, error: errMsg, executionId };
    }
  }

  return { success: false, output: null, error: 'Execution timed out after 120s', executionId };
}

// ── PA flow trigger ───────────────────────────────────────────────────────────

async function triggerPaFlow(
  orgUrl: string,
  msToken: string,
  workflowId: string,
  _args: Record<string, unknown>,
): Promise<{ triggered: boolean; output: unknown | null; error?: string }> {
  // PA Management API — run a flow via workflow trigger
  // Only works for HTTP-triggered flows or flows with a manual trigger
  try {
    const url = `${orgUrl}/api/data/v9.2/workflows(${workflowId})/Microsoft.Dynamics.CRM.ExecuteWorkflow`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${msToken}`,
        'Content-Type': 'application/json',
        'OData-MaxVersion': '4.0',
        'OData-Version': '4.0',
      },
      body: JSON.stringify({}),
    });

    if (!res.ok) {
      const body = await res.text();
      return { triggered: false, output: null, error: `PA trigger failed: ${res.status} ${body}` };
    }

    return { triggered: true, output: null }; // PA doesn't return output synchronously
  } catch (err) {
    logger.warn({ err, workflowId }, 'PA flow trigger failed');
    return { triggered: false, output: null, error: (err as Error).message };
  }
}

// ── Output comparison ─────────────────────────────────────────────────────────

function compareOutputs(
  gcpOutput: unknown,
  paOutput: unknown,
  paTriggered: boolean,
): { match: boolean | null; details: string } {
  if (!paTriggered || paOutput === null) {
    // PA side not triggered — can only verify GCP ran without error
    if (gcpOutput !== null) {
      return {
        match: null,
        details: 'GCP workflow executed successfully. PA comparison not available — trigger PA flow manually to compare.',
      };
    }
    return { match: null, details: 'GCP workflow failed. PA comparison not attempted.' };
  }

  // Both sides ran — deep compare
  const gcpStr = JSON.stringify(gcpOutput ?? {});
  const paStr = JSON.stringify(paOutput ?? {});

  if (gcpStr === paStr) {
    return { match: true, details: 'Outputs match exactly.' };
  }

  // Try partial match — GCP may return subset
  const gcpKeys = Object.keys(typeof gcpOutput === 'object' && gcpOutput !== null ? gcpOutput as object : {});
  const paKeys = Object.keys(typeof paOutput === 'object' && paOutput !== null ? paOutput as object : {});
  const commonKeys = gcpKeys.filter((k) => paKeys.includes(k));

  if (commonKeys.length > 0) {
    const mismatches = commonKeys.filter((k) => {
      const g = (gcpOutput as Record<string, unknown>)[k];
      const p = (paOutput as Record<string, unknown>)[k];
      return JSON.stringify(g) !== JSON.stringify(p);
    });

    if (mismatches.length === 0) {
      return { match: true, details: `Common fields match (${commonKeys.join(', ')}).` };
    }
    return {
      match: false,
      details: `Mismatch on fields: ${mismatches.join(', ')}. Sending to Hermas fix loop.`,
    };
  }

  return { match: false, details: 'Outputs differ. Sending to Hermas fix loop.' };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Check if a flow doc has a stored parallel result that passed.
 */
export function parallelResultPassed(flow: WorkflowFlowDoc): boolean {
  return flow.parallelResult?.match === true || flow.testPassed === true;
}
