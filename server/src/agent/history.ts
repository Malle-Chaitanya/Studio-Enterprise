import { getDb, isDbConnected } from '../db/core.js';
import { logger } from '../logger.js';

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface HistoryDoc {
  key: string;
  appUserId: string;
  sessionId: string;
  messages: HistoryMessage[];
  updatedAt: Date;
}

const COLL = 'agentChatHistory';
const mem = new Map<string, HistoryMessage[]>();

function key(appUserId: string, sessionId: string): string {
  return `${appUserId}::${sessionId}`;
}

export async function loadHistory(appUserId: string, sessionId: string): Promise<HistoryMessage[]> {
  const k = key(appUserId, sessionId);
  if (!isDbConnected()) return [...(mem.get(k) ?? [])];
  try {
    const doc = await getDb().collection<HistoryDoc>(COLL).findOne({ key: k });
    return doc?.messages ?? [...(mem.get(k) ?? [])];
  } catch (e) {
    logger.warn(`loadHistory failed: ${(e as Error).message}`);
    return [...(mem.get(k) ?? [])];
  }
}

export async function saveHistory(
  appUserId: string,
  sessionId: string,
  messages: HistoryMessage[],
): Promise<void> {
  const k = key(appUserId, sessionId);
  mem.set(k, messages);
  if (!isDbConnected()) return;
  try {
    await getDb()
      .collection<HistoryDoc>(COLL)
      .updateOne(
        { key: k },
        { $set: { key: k, messages, appUserId, sessionId, updatedAt: new Date() } },
        { upsert: true },
      );
  } catch (e) {
    logger.warn(`saveHistory failed: ${(e as Error).message}`);
  }
}

export async function clearHistory(appUserId: string, sessionId: string): Promise<void> {
  const k = key(appUserId, sessionId);
  mem.delete(k);
  if (!isDbConnected()) return;
  try {
    await getDb().collection<HistoryDoc>(COLL).deleteOne({ key: k });
  } catch (e) {
    logger.warn(`clearHistory failed: ${(e as Error).message}`);
  }
}
