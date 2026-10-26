/**
 * Adds Google Calendar's `get_current_datetime` as a real database row — closing the LAST
 * reason calendar.py is still imported at deploy time. This is not an HTTP operation at all
 * ("what time is it right now" has no vendor endpoint to call), so it uses the new, generic
 * `localCompute` chain-step kind (operationBinding.ts / generic_rest.py) instead of a
 * urlTemplate: a pure local computation, no network call, executed by the same generic
 * engine as every other catalog operation.
 *
 * Nothing here is Calendar-specific code — `localCompute` is a generic chain-step capability
 * any future connector needing a non-API local value (not just a clock) can reuse.
 *
 * Proven first against a mocked executor (scripts/_test_chain_operations.py, check #12, 5/5
 * passing, including an assertion that NO HTTP call is ever made) before being approved here.
 *
 *   npx tsx src/spikes/_add_calendar_get_current_datetime.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { putCatalogOperation } from '../db/repos/connectorCatalog.js';

const CONNECTOR_ID = 'shared_googlecalendar';
const CATALOG_VERSION = 1;

await connectMongo();

await putCatalogOperation({
  connectorId: CONNECTOR_ID,
  operationKey: 'get_current_datetime',
  displayName: 'Get the current date and time',
  method: 'POST',
  path: '',
  parameters: [
    {
      name: 'timezone',
      in: 'query',
      required: false,
      type: 'string',
      description: 'IANA timezone name, e.g. "Asia/Kolkata". Omit for UTC.',
    },
  ],
  auth: { mode: 'app-only', requiredPermissions: [] },
  chain: [
    {
      localCompute: { kind: 'current_datetime', timezoneParam: 'timezone', bindAs: 'now' },
    },
  ],
  sourceOperationIds: [],
  alwaysOnForConnector: true,
  lifecycle: { status: 'approved' },
  catalogVersion: CATALOG_VERSION,
});

console.log('Added Google Calendar get_current_datetime — approved, localCompute (no HTTP call).');
process.exit(0);
