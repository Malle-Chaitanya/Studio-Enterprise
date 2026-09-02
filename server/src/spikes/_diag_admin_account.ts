import { listWorkspaceUsersFilteredAsAdmin } from '../auth/google.js';

const ADMIN = 'admin@migrationn.com';
try {
  const { users } = await listWorkspaceUsersFilteredAsAdmin(ADMIN, { max: 200, activeOnly: false });
  console.log('DWD impersonation of', ADMIN, 'SUCCEEDED —', users.length, 'users read');
  const me = users.find((u) => u.email?.toLowerCase() === ADMIN);
  console.log('admin row:', me ? JSON.stringify(me) : '(not in first page)');
} catch (e) {
  console.log('DWD impersonation FAILED:', (e as Error).message.slice(0, 400));
}
