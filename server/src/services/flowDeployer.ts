/**
 * flowDeployer — deploys a Cloud Workflow YAML to a customer's own GCP project
 * and runs a test execution to verify it works end-to-end.
 *
 * All GCP API calls are plain `fetch` with the customer's Google OAuth access
 * token (Bearer). No Google SDK is required on the server.
 *
 * Trigger-specific infrastructure:
 *   - Recurrence flows → Cloud Scheduler job (calls the workflow on a cron)
 *   - Webhook flows    → Pub/Sub topic (EventArc subscription wired separately)
 */

import { logger } from '../logger.js';

// ── GCP base URLs ─────────────────────────────────────────────────────────────

const WORKFLOWS_API = 'https://workflows.googleapis.com/v1';
const EXECUTIONS_API = 'https://workflowexecutions.googleapis.com/v1';
const SCHEDULER_API = 'https://cloudscheduler.googleapis.com/v1';
const PUBSUB_API = 'https://pubsub.googleapis.com/v1';

// ── Public interfaces ─────────────────────────────────────────────────────────

/** Configuration for a Cloud Scheduler job that triggers the workflow on a cron. */
export interface SchedulerConfig {
  /** Cloud Scheduler job id (just the short name, not the full resource path). */
  jobName: string;
  /** Cron expression, e.g. "0 9 * * 1" for Monday 09:00. */
  schedule: string;
  /** IANA timezone, e.g. "America/New_York". */
  timeZone: string;
}

/** Configuration for a Pub/Sub topic that fronts a Webhook-triggered workflow. */
export interface PubSubConfig {
  /** Topic id (short name, not the full resource path). */
  topicName: string;
}

export interface DeployResult {
  success: boolean;
  /** Name deployed as in Cloud Workflows. */
  workflowName: string;
  /** GCP console deep-link for the workflow. */
  workflowUrl: string;
  /** Test execution id (present when testExecution ran). */
  executionId?: string;
  testPassed: boolean;
  testOutput?: unknown;
  testError?: string;
  /** Cloud Scheduler job resource name, for Recurrence flows. */
  schedulerJobName?: string;
  /** Pub/Sub topic resource name, for Webhook flows. */
  pubSubTopicName?: string;
  error?: string;
}

export interface DeployOptions {
  /** Customer's GCP project id or number. */
  projectId: string;
  /** GCP region, e.g. "us-central1". */
  region: string;
  /** Customer's Google OAuth access token (delegated, scoped to cloud-platform). */
  gcpAccessToken: string;
  /** Short workflow name to deploy as (used in the resource path). */
  workflowName: string;
  /** Cloud Workflow YAML content. */
  yaml: string;
  /** Present when the flow has a Recurrence trigger. */
  schedulerConfig?: SchedulerConfig;
  /** Present when the flow has a Webhook trigger. */
  pubSubConfig?: PubSubConfig;
  /** Arguments forwarded to the test execution. */
  testArgs?: Record<string, unknown>;
}

export interface ExecutionResult {
  success: boolean;
  output: unknown;
  error?: string;
  executionId: string;
}

// ── Internal GCP response shapes ──────────────────────────────────────────────

interface WorkflowResource {
  name?: string;
  state?: 'STATE_UNSPECIFIED' | 'ACTIVE' | 'FAILED' | 'DEPLOYING' | 'DELETING' | string;
  stateError?: { details?: string; type?: string };
}

interface ExecutionResource {
  name?: string;
  state?: 'STATE_UNSPECIFIED' | 'ACTIVE' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'UNAVAILABLE' | 'QUEUED' | string;
  result?: string;
  error?: { payload?: string; context?: string };
  startTime?: string;
  endTime?: string;
}

interface SchedulerJobResource {
  name?: string;
}

interface PubSubTopicResource {
  name?: string;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

/** Standard auth + JSON headers for every GCP call. */
function gcpHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

/** Throw a structured error when a GCP API call returns non-2xx. */
async function assertOk(res: Response, context: string): Promise<void> {
  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText);
    throw new Error(`GCP ${context} failed (${res.status}): ${body.replace(/\s+/g, ' ').slice(0, 400)}`);
  }
}

// ── Workflow resource helpers ─────────────────────────────────────────────────

function workflowPath(projectId: string, region: string, workflowName: string): string {
  return `${WORKFLOWS_API}/projects/${projectId}/locations/${region}/workflows/${workflowName}`;
}

/** Deploy (create-or-update) the workflow YAML via Cloud Workflows REST API. */
async function deployWorkflowYaml(
  projectId: string,
  region: string,
  workflowName: string,
  yaml: string,
  token: string,
): Promise<void> {
  const url = workflowPath(projectId, region, workflowName);
  logger.info({ workflowName, projectId, region }, 'flowDeployer: deploying workflow YAML');

  const res = await fetch(url, {
    method: 'PUT',
    headers: gcpHeaders(token),
    body: JSON.stringify({ sourceContents: yaml }),
    signal: AbortSignal.timeout(30_000),
  });

  await assertOk(res, `workflows.put/${workflowName}`);
}

/**
 * Poll `GET .../workflows/{name}` until `state = ACTIVE`, max 30 s, every 2 s.
 * Throws if the workflow reaches FAILED state or times out.
 */
async function waitForWorkflowActive(
  projectId: string,
  region: string,
  workflowName: string,
  token: string,
): Promise<void> {
  const url = workflowPath(projectId, region, workflowName);
  const maxAttempts = 15; // 15 × 2 s = 30 s
  const pollIntervalMs = 2_000;

  logger.info({ workflowName }, 'flowDeployer: polling workflow until ACTIVE');

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await sleep(pollIntervalMs);

    const res = await fetch(url, {
      headers: gcpHeaders(token),
      signal: AbortSignal.timeout(10_000),
    });

    await assertOk(res, `workflows.get/${workflowName}`);

    const wf = (await res.json()) as WorkflowResource;

    if (wf.state === 'ACTIVE') {
      logger.info({ workflowName, attempt }, 'flowDeployer: workflow is ACTIVE');
      return;
    }

    if (wf.state === 'FAILED') {
      const detail = wf.stateError?.details ?? 'unknown';
      throw new Error(`Workflow deployment entered FAILED state: ${detail}`);
    }

    logger.debug({ workflowName, state: wf.state, attempt }, 'flowDeployer: waiting for workflow ACTIVE');
  }

  throw new Error(`Workflow deployment timed out after ${maxAttempts * pollIntervalMs / 1000}s (still not ACTIVE)`);
}

// ── Cloud Scheduler helper ────────────────────────────────────────────────────

async function createSchedulerJob(
  projectId: string,
  region: string,
  workflowName: string,
  cfg: SchedulerConfig,
  token: string,
): Promise<string> {
  const url = `${SCHEDULER_API}/projects/${projectId}/locations/${region}/jobs`;
  const workflowsUri = `projects/${projectId}/locations/${region}/workflows/${workflowName}`;
  const jobResourceName = `projects/${projectId}/locations/${region}/jobs/${cfg.jobName}`;

  logger.info({ jobName: cfg.jobName, workflowName }, 'flowDeployer: creating Cloud Scheduler job');

  const res = await fetch(url, {
    method: 'POST',
    headers: gcpHeaders(token),
    body: JSON.stringify({
      name: jobResourceName,
      schedule: cfg.schedule,
      timeZone: cfg.timeZone,
      workflowsTarget: {
        workflowsUri,
        serviceAccountEmail: `${projectId}@appspot.gserviceaccount.com`,
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });

  await assertOk(res, `scheduler.jobs.create/${cfg.jobName}`);

  const job = (await res.json()) as SchedulerJobResource;
  const created = job.name ?? jobResourceName;
  logger.info({ jobName: created }, 'flowDeployer: Cloud Scheduler job created');
  return created;
}

// ── Pub/Sub topic helper ──────────────────────────────────────────────────────

async function createPubSubTopic(
  projectId: string,
  cfg: PubSubConfig,
  token: string,
): Promise<string> {
  const topicResourceName = `projects/${projectId}/topics/${cfg.topicName}`;
  const url = `${PUBSUB_API}/${topicResourceName}`;

  logger.info({ topicName: cfg.topicName, projectId }, 'flowDeployer: creating Pub/Sub topic');

  const res = await fetch(url, {
    method: 'PUT',
    headers: gcpHeaders(token),
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(15_000),
  });

  // 409 Conflict means the topic already exists — treat as success.
  if (res.status !== 409) {
    await assertOk(res, `pubsub.topics.create/${cfg.topicName}`);
  }

  const topic = (await res.json()) as PubSubTopicResource;
  const created = topic.name ?? topicResourceName;
  logger.info({ topicName: created }, 'flowDeployer: Pub/Sub topic ready');
  return created;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Deploy a Cloud Workflow YAML to the customer's GCP project, optionally create
 * trigger infrastructure (Scheduler job / Pub/Sub topic), then run a test
 * execution and return a structured result.
 */
export async function deployFlow(opts: DeployOptions): Promise<DeployResult> {
  const { projectId, region, gcpAccessToken, workflowName, yaml } = opts;

  const workflowUrl =
    `https://console.cloud.google.com/workflows/details/${region}/${workflowName}` +
    `?project=${projectId}`;

  const baseResult: Omit<DeployResult, 'success' | 'testPassed'> = {
    workflowName,
    workflowUrl,
  };

  // 1. Deploy the workflow YAML.
  try {
    await deployWorkflowYaml(projectId, region, workflowName, yaml, gcpAccessToken);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, workflowName }, 'flowDeployer: workflow deploy failed');
    return { ...baseResult, success: false, testPassed: false, error: `Deploy failed: ${message}` };
  }

  // 2. Wait for ACTIVE state.
  try {
    await waitForWorkflowActive(projectId, region, workflowName, gcpAccessToken);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, workflowName }, 'flowDeployer: workflow did not reach ACTIVE');
    return { ...baseResult, success: false, testPassed: false, error: `Activation wait failed: ${message}` };
  }

  // 3. Create Cloud Scheduler job (Recurrence flows).
  let schedulerJobName: string | undefined;
  if (opts.schedulerConfig) {
    try {
      schedulerJobName = await createSchedulerJob(
        projectId,
        region,
        workflowName,
        opts.schedulerConfig,
        gcpAccessToken,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err, workflowName }, 'flowDeployer: Cloud Scheduler creation failed (non-fatal)');
      // Scheduler failure is non-fatal — workflow is deployed; report it in error.
      return {
        ...baseResult,
        success: false,
        testPassed: false,
        error: `Workflow deployed but Scheduler job creation failed: ${message}`,
      };
    }
  }

  // 4. Create Pub/Sub topic (Webhook flows).
  let pubSubTopicName: string | undefined;
  if (opts.pubSubConfig) {
    try {
      pubSubTopicName = await createPubSubTopic(projectId, opts.pubSubConfig, gcpAccessToken);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err, workflowName }, 'flowDeployer: Pub/Sub topic creation failed (non-fatal)');
      return {
        ...baseResult,
        success: false,
        testPassed: false,
        schedulerJobName,
        error: `Workflow deployed but Pub/Sub topic creation failed: ${message}`,
      };
    }
  }

  // 5. Run a test execution.
  let execResult: ExecutionResult;
  try {
    execResult = await testExecution(
      projectId,
      region,
      workflowName,
      gcpAccessToken,
      opts.testArgs ?? {},
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, workflowName }, 'flowDeployer: test execution threw unexpectedly');
    return {
      ...baseResult,
      success: true, // workflow IS deployed even if test harness failed
      testPassed: false,
      schedulerJobName,
      pubSubTopicName,
      testError: `Test execution error: ${message}`,
    };
  }

  logger.info(
    { workflowName, executionId: execResult.executionId, success: execResult.success },
    'flowDeployer: deploy complete',
  );

  return {
    ...baseResult,
    success: true,
    testPassed: execResult.success,
    executionId: execResult.executionId,
    testOutput: execResult.output,
    testError: execResult.error,
    schedulerJobName,
    pubSubTopicName,
  };
}

/**
 * Create a test execution for an already-deployed workflow and poll until it
 * reaches a terminal state (SUCCEEDED / FAILED / CANCELLED), max 60 s.
 */
export async function testExecution(
  projectId: string,
  region: string,
  workflowName: string,
  gcpAccessToken: string,
  args?: Record<string, unknown>,
): Promise<ExecutionResult> {
  // 1. Create the execution.
  const createUrl =
    `${EXECUTIONS_API}/projects/${projectId}/locations/${region}` +
    `/workflows/${workflowName}/executions`;

  logger.info({ workflowName, projectId, region }, 'flowDeployer: creating test execution');

  const createRes = await fetch(createUrl, {
    method: 'POST',
    headers: gcpHeaders(gcpAccessToken),
    body: JSON.stringify({ argument: JSON.stringify(args ?? {}) }),
    signal: AbortSignal.timeout(15_000),
  });

  await assertOk(createRes, `executions.create/${workflowName}`);

  const created = (await createRes.json()) as ExecutionResource;
  const executionName = created.name;
  if (!executionName) {
    throw new Error('Cloud Workflows API returned an execution with no name');
  }

  const executionId = executionName.split('/').pop() ?? executionName;
  logger.info({ executionId, workflowName }, 'flowDeployer: test execution created, polling');

  // 2. Poll until terminal state.
  const pollUrl = `${EXECUTIONS_API}/${executionName}`;
  const maxAttempts = 30; // 30 × 2 s = 60 s
  const pollIntervalMs = 2_000;

  const terminalStates = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNAVAILABLE']);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await sleep(pollIntervalMs);

    const pollRes = await fetch(pollUrl, {
      headers: gcpHeaders(gcpAccessToken),
      signal: AbortSignal.timeout(10_000),
    });

    await assertOk(pollRes, `executions.get/${executionId}`);

    const exec = (await pollRes.json()) as ExecutionResource;

    if (!exec.state || !terminalStates.has(exec.state)) {
      logger.debug({ state: exec.state, attempt, executionId }, 'flowDeployer: waiting for execution terminal state');
      continue;
    }

    if (exec.state === 'SUCCEEDED') {
      let output: unknown = exec.result;
      try {
        output = exec.result ? (JSON.parse(exec.result) as unknown) : null;
      } catch {
        // result is a plain string — keep as-is
      }
      logger.info({ executionId, workflowName }, 'flowDeployer: test execution SUCCEEDED');
      return { success: true, output, executionId };
    }

    // FAILED / CANCELLED / UNAVAILABLE
    const errPayload = exec.error?.payload ?? exec.error?.context ?? exec.state;
    logger.warn({ executionId, state: exec.state, workflowName }, 'flowDeployer: test execution did not succeed');
    return {
      success: false,
      output: null,
      error: `Execution ${exec.state}: ${errPayload}`,
      executionId,
    };
  }

  // Timed out.
  logger.warn({ executionId, workflowName }, 'flowDeployer: test execution timed out');
  return {
    success: false,
    output: null,
    error: `Execution timed out after ${maxAttempts * pollIntervalMs / 1000}s`,
    executionId,
  };
}

/**
 * Delete a Cloud Workflow by name. Idempotent — a 404 is silently ignored.
 */
export async function deleteFlow(
  projectId: string,
  region: string,
  workflowName: string,
  gcpAccessToken: string,
): Promise<void> {
  const url = workflowPath(projectId, region, workflowName);
  logger.info({ workflowName, projectId, region }, 'flowDeployer: deleting workflow');

  const res = await fetch(url, {
    method: 'DELETE',
    headers: gcpHeaders(gcpAccessToken),
    signal: AbortSignal.timeout(15_000),
  });

  // 404 = already gone — treat as success.
  if (res.status === 404) {
    logger.info({ workflowName }, 'flowDeployer: workflow already deleted (404)');
    return;
  }

  await assertOk(res, `workflows.delete/${workflowName}`);
  logger.info({ workflowName }, 'flowDeployer: workflow deleted');
}

// ── Utility ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
