/**
 * Read Copilot Studio agent memory out of Dataverse, and write it into a migrated
 * agent's Vertex AI Memory Bank.
 *
 * The mapping rules (privacy, TTL, inference) live in `memory.ts`, which is pure and
 * tested. This file is only the two I/O ends.
 *
 * Memory is the most sensitive thing this tool moves: `intelligentmemory` holds
 * statements a model INFERRED about named people. Two rules follow and neither is
 * negotiable — the extractor never logs a fact's content (only counts), and a fact whose
 * subject cannot be mapped to a destination identity is refused rather than widened
 * (enforced in `scopeFor`).
 */
import { logger } from '../logger.js';
import type { FidelityNote } from '../types.js';
import { planMemoryMigration, unattributedMemoryNote, type MemoryBankWrite, type MemoryFactIR } from './memory.js';

const API_VERSION = 'v9.2';

interface RawMemoryRow {
  intelligentmemoryid: string;
  subject?: string;
  predicate?: string;
  targetobject?: string;
  memorykind?: string;
  memorytype?: string;
  memorysource?: string;
  privacylevel?: string;
  ttlinseconds?: number;
  sourceid?: string;
  createdon?: string;
}

/**
 * Read every memory row in an environment.
 *
 * Returns `undefined` (not an empty array) when the table cannot be read at all, so the
 * caller can tell "this customer has no memory" apart from "we could not look" — the
 * distinction the report depends on. Environments provisioned before the feature shipped
 * do not have the table, and that is not an error.
 */
export async function readEnvironmentMemory(
  envUrl: string,
  token: string,
): Promise<MemoryFactIR[] | undefined> {
  const base = `${envUrl.replace(/\/$/, '')}/api/data/${API_VERSION}`;
  const select = 'intelligentmemoryid,subject,predicate,targetobject,memorykind,memorytype,memorysource,privacylevel,ttlinseconds,sourceid,createdon';
  let next: string | null = `${base}/intelligentmemories?$select=${select}`;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json', Prefer: 'odata.maxpagesize=500' };
  const rows: RawMemoryRow[] = [];

  while (next) {
    let res: Response;
    try {
      res = await fetch(next, { headers });
    } catch (err) {
      logger.warn(`memory: could not reach ${envUrl} (${(err as Error).message})`);
      return undefined;
    }
    if (!res.ok) {
      // 404 here means the environment predates agent memory — a fact about the tenant,
      // not a failure. Anything else is a real read failure and must not read as "none".
      if (res.status === 404) return undefined;
      logger.warn(`memory: read failed (${res.status}) for ${envUrl}`);
      return undefined;
    }
    const json = (await res.json()) as { value?: RawMemoryRow[]; '@odata.nextLink'?: string };
    rows.push(...(json.value ?? []));
    next = json['@odata.nextLink'] ?? null;
  }

  return rows.map((r) => ({
    id: r.intelligentmemoryid,
    subject: r.subject ?? '',
    predicate: r.predicate ?? '',
    targetObject: r.targetobject ?? '',
    memoryKind: r.memorykind,
    memoryType: r.memorytype,
    memorySource: r.memorysource,
    privacyLevel: r.privacylevel,
    ttlSeconds: r.ttlinseconds,
    sourceId: r.sourceid,
    createdOn: r.createdon,
  }));
}

/**
 * Split an environment's memory between the agents being migrated.
 *
 * `intelligentmemory` has no bot relationship, so the ONLY honest attribution is an exact
 * `sourceid` match against a botid. Anything looser (matching on subject, on time, on
 * "the only agent in the run") would attach one person's remembered details to an agent
 * that never learned them.
 */
export function attributeMemory(
  facts: MemoryFactIR[],
  botIds: string[],
): { byAgent: Map<string, MemoryFactIR[]>; unattributed: MemoryFactIR[] } {
  const wanted = new Set(botIds.map((b) => b.toLowerCase()));
  const byAgent = new Map<string, MemoryFactIR[]>();
  const unattributed: MemoryFactIR[] = [];
  for (const f of facts) {
    const src = (f.sourceId ?? '').toLowerCase();
    if (src && wanted.has(src)) {
      const list = byAgent.get(src) ?? [];
      list.push(f);
      byAgent.set(src, list);
    } else {
      unattributed.push(f);
    }
  }
  return { byAgent, unattributed };
}

/**
 * Write planned memories into a reasoning engine's Memory Bank.
 *
 * Creation is a long-running operation. We poll it, because "the POST returned 200" only
 * means the operation was accepted — reporting a memory as migrated on the strength of an
 * accepted LRO is the same overclaim as calling a deployed agent a working one.
 */
export async function writeMemoriesToBank(
  opts: {
    project: string;
    location: string;
    reasoningEngineId: string;
    saToken: string;
  },
  writes: MemoryBankWrite[],
): Promise<{ written: number; notes: FidelityNote[] }> {
  const notes: FidelityNote[] = [];
  if (!writes.length) return { written: 0, notes };

  const base =
    `https://${opts.location}-aiplatform.googleapis.com/v1beta1/projects/${opts.project}` +
    `/locations/${opts.location}/reasoningEngines/${opts.reasoningEngineId}`;
  const headers = { Authorization: `Bearer ${opts.saToken}`, 'Content-Type': 'application/json' };
  let written = 0;

  for (const w of writes) {
    try {
      const res = await fetch(`${base}/memories`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ fact: w.fact, scope: w.scope }),
      });
      if (!res.ok) {
        // Never echo the fact — the failure detail must not become the leak.
        notes.push({
          component: `memory:${w.sourceFactId}`,
          status: 'lost',
          detail: `A remembered detail could not be written to the agent's memory (HTTP ${res.status}).`,
        });
        continue;
      }
      const op = (await res.json()) as { name?: string; done?: boolean };
      if (op.name?.includes('/operations/')) {
        const ok = await awaitOperation(op.name, opts.location, opts.saToken);
        if (!ok) {
          notes.push({
            component: `memory:${w.sourceFactId}`,
            status: 'needs-review',
            detail:
              'A remembered detail was accepted for writing but its operation did not confirm ' +
              'in time. Verify it is present before relying on it.',
          });
          continue;
        }
      }
      written++;
    } catch (err) {
      notes.push({
        component: `memory:${w.sourceFactId}`,
        status: 'lost',
        detail: `A remembered detail could not be written to the agent's memory (${(err as Error).message}).`,
      });
    }
  }

  return { written, notes };
}

async function awaitOperation(name: string, location: string, saToken: string): Promise<boolean> {
  const url = `https://${location}-aiplatform.googleapis.com/v1beta1/${name}`;
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${saToken}` } });
      if (!res.ok) return false;
      const op = (await res.json()) as { done?: boolean; error?: unknown };
      if (op.done) return !op.error;
    } catch {
      /* transient — keep polling within the budget */
    }
  }
  return false;
}

/**
 * The whole per-agent memory step: plan, write, and report.
 *
 * Returns notes even when nothing was written, because "this agent had memory and now has
 * none" is exactly what the report exists to say.
 */
export async function migrateAgentMemory(
  facts: MemoryFactIR[],
  identityMap: Map<string, string>,
  target: { project: string; location: string; reasoningEngineId: string; saToken: string },
  now: Date = new Date(),
): Promise<{ written: number; notes: FidelityNote[] }> {
  const { writes, notes } = planMemoryMigration(facts, identityMap, now);
  const result = await writeMemoriesToBank(target, writes);
  return { written: result.written, notes: [...notes, ...result.notes] };
}

export { unattributedMemoryNote };
