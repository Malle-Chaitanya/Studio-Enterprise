import bcrypt from 'bcryptjs';
import { config } from '../../config.js';
import { getDb, isDbConnected } from '../core.js';

/**
 * App user accounts (collection: appUsers). Seeded on first boot in db/mongo.ts.
 * These helpers are ready for a login route to consume — the migration pipeline
 * scopes by appUserId but doesn't yet require a real login (see
 * DEFAULT_APP_USER_ID in sessionStore.ts).
 */

const COLL = 'appUsers';

export interface AppUser {
  _id: string;
  email: string;
  name: string;
  role: 'admin' | 'user';
  password: string; // bcrypt hash
  createdAt: Date;
}

export async function findUserByEmail(email: string): Promise<AppUser | null> {
  if (!isDbConnected()) return null;
  return getDb(config.CSGE_DB).collection<AppUser>(COLL).findOne({ email });
}

/** Verify a login. Returns the user (minus password) on success, else null. */
export async function verifyLogin(
  email: string,
  password: string,
): Promise<Omit<AppUser, 'password'> | null> {
  const user = await findUserByEmail(email);
  if (!user) return null;
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return null;
  const { password: _pw, ...safe } = user;
  void _pw;
  return safe;
}
