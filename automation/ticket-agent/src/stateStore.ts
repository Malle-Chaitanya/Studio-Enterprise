import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// `new URL(...).pathname` produces a malformed leading-slash path on Windows
// (e.g. "/C:/Users/..." collapses into "C:\C:\Users\..." once Node resolves
// it) - fileURLToPath handles this correctly. Shared here so index.ts,
// check.ts, and runOnce.ts don't each get their own chance to regress it.
export function defaultStatePath(importMetaUrl: string): string {
  return path.join(path.dirname(fileURLToPath(importMetaUrl)), '..', 'state.json');
}

export type TicketState =
  | { phase: 'in_progress'; startedAt: string }
  | { phase: 'done'; prUrl: string; branch: string; finishedAt: string }
  | { phase: 'no_change_needed'; finishedAt: string }
  | { phase: 'blocked'; reason: string; finishedAt: string };

type StateFile = Record<string, TicketState>;

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

// Dedupe/resume tracking so a restart never reprocesses a ticket it already
// opened a PR for. Deliberately a flat JSON file, not a DB - this tool has
// exactly one reader/writer and no need for the persistence machinery the
// main app uses.
export class StateStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<StateFile> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      return JSON.parse(raw) as StateFile;
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') return {};
      throw error;
    }
  }

  async set(ticketId: string, state: TicketState): Promise<void> {
    const current = await this.load();
    current[ticketId] = state;
    await writeFile(this.filePath, JSON.stringify(current, null, 2));
  }
}
