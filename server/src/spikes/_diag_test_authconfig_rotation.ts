/** Live test: does ensureAuthConfig() correctly detect a credential change and PATCH
 *  the existing AuthConfig, and correctly skip when nothing changed? Uses the real
 *  ms_graph AuthConfig this session already created and the real appUserId/credential
 *  records already in Mongo. Read-only on the real secret material (never mutates it) —
 *  only the AuthConfig's stored comparison hash may be written.
 *  npx tsx src/spikes/_diag_test_authconfig_rotation.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { getSaToken } from '../auth/google.js';
import { ensureAuthConfig } from '../services/applicationIntegration.js';
import { getFlowAuthConfigHash } from '../db/repos/flowAuthConfigs.js';

await connectMongo();
const saToken = await getSaToken();
const PROJECT = 'agentmigrations';

const appUserId = '6a5dfdff7cf05623332758b7';

console.log('\n--- Call 1: should be a genuine create-or-confirm (first run this test) ---');
const r1 = await ensureAuthConfig(saToken, PROJECT, appUserId, 'ms_graph');
console.log('Result 1:', JSON.stringify(r1));
const hashAfter1 = await getFlowAuthConfigHash(appUserId, PROJECT, 'ms_graph');
console.log('Stored hash after call 1:', hashAfter1);

console.log('\n--- Call 2: same credentials, same call — MUST be a no-op (skip) ---');
const r2 = await ensureAuthConfig(saToken, PROJECT, appUserId, 'ms_graph');
console.log('Result 2:', JSON.stringify(r2));
const hashAfter2 = await getFlowAuthConfigHash(appUserId, PROJECT, 'ms_graph');
console.log('Stored hash after call 2 (should be identical to call 1):', hashAfter2, hashAfter2 === hashAfter1 ? 'MATCH (correctly skipped)' : 'MISMATCH — unexpected');

console.log('\n--- Simulating a rotated secret: manually clearing the stored hash ---');
// Simulates "the credential changed" without touching the REAL secret material — clearing
// our own comparison record is functionally identical to the secret's plaintext having
// changed, from ensureAuthConfig's point of view (it always re-reads the CURRENT secret
// and compares against the stored hash).
await getDb().collection('flowAuthConfigs').deleteOne({ appUserId, project: PROJECT, authConfigName: 'ms_graph' });
console.log('\n--- Call 3: stored hash cleared — should detect "changed" and PATCH ---');
const r3 = await ensureAuthConfig(saToken, PROJECT, appUserId, 'ms_graph');
console.log('Result 3:', JSON.stringify(r3));
const hashAfter3 = await getFlowAuthConfigHash(appUserId, PROJECT, 'ms_graph');
console.log('Stored hash after call 3 (should be re-populated, matching call 1):', hashAfter3, hashAfter3 === hashAfter1 ? 'MATCH (correctly re-detected and re-applied same real credential)' : 'MISMATCH');
process.exit(0);
