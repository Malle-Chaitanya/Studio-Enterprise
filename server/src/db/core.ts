import { MongoClient, type Db } from 'mongodb';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Unified DB factory — one MongoClient per database name, cached.
 * Ported from the GEM_CO reference (src/core/db.js) to TypeScript.
 *
 *   import { connectDb, getDb } from './db/core.js';
 *   await connectDb('csge');
 *   const db = getDb('csge');
 */

interface Conn {
  client: MongoClient;
  db: Db;
}

const connections = new Map<string, Conn>();

/** Strip any `/dbname` path from the base URI so we can append our own. */
function stripDbFromUri(raw: string): string {
  const afterScheme = raw.indexOf('://');
  if (afterScheme === -1) return raw;
  const pathStart = raw.indexOf('/', afterScheme + 3);
  if (pathStart === -1) return raw; // no /dbname present
  return raw.substring(0, pathStart);
}

/**
 * Connect to `dbName` and cache the connection. Safe to call repeatedly for the
 * same name (no-op after the first success). Retries with backoff on transient
 * failures, matching the GEM_CO factory.
 */
export async function connectDb(dbName: string, retries = 5, delayMs = 3000): Promise<void> {
  if (connections.has(dbName)) return;

  const base = stripDbFromUri(config.MONGO_HOST);
  const uri = `${base}/${dbName}?authSource=admin`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const client = new MongoClient(uri, {
        serverSelectionTimeoutMS: 10000,
        connectTimeoutMS: 10000,
        socketTimeoutMS: 0,
        maxPoolSize: 10,
        retryWrites: true,
        retryReads: true,
      });
      await client.connect();
      connections.set(dbName, { client, db: client.db(dbName) });
      logger.info(`MongoDB connected -> ${dbName}`);
      return;
    } catch (err) {
      logger.warn(
        `MongoDB connect attempt ${attempt}/${retries} for "${dbName}" failed: ${(err as Error).message}`,
      );
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

/** Return a cached Db instance. Throws if connectDb() was not called first. */
export function getDb(dbName: string = config.CSGE_DB): Db {
  const conn = connections.get(dbName);
  if (!conn) throw new Error(`DB "${dbName}" not connected — call connectDb('${dbName}') first`);
  return conn.db;
}

/** True once the default db has an active cached connection. */
export function isDbConnected(dbName: string = config.CSGE_DB): boolean {
  return connections.has(dbName);
}

/** Close all connections (tests / graceful shutdown). */
export async function closeDb(): Promise<void> {
  for (const [name, { client }] of connections) {
    await client.close().catch(() => {});
    connections.delete(name);
  }
}
