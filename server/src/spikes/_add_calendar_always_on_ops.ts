/**
 * Adds Google Calendar's bonus capabilities with NO Microsoft source equivalent — confirmed
 * directly against Microsoft's real connector reference page (re-checked 2026-10-22: no
 * "check availability", "current date/time", or "respond to event" action exists there at
 * all) — as `alwaysOnForConnector` rows.
 *
 * `get_current_datetime` is NOT here, deliberately — see the note where it's addressed
 * separately: it needs no HTTP call at all (it's "what time is it right now"), so there is
 * no catalog row that could ever represent it; this architecture only describes HTTP calls.
 *
 *   npx tsx src/spikes/_add_calendar_always_on_ops.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { putCatalogOperation } from '../db/repos/connectorCatalog.js';

const CONNECTOR_ID = 'shared_googlecalendar';
const CATALOG_VERSION = 1;

await connectMongo();

// check_availability — real Calendar API: POST .../freeBusy with {timeMin, timeMax,
// items:[{id: calendarId}]}. A single call; built via a 1-step chain so the JSON body is
// assembled safely from separate named arguments rather than asking the model to construct
// nested JSON freehand.
await putCatalogOperation({
  connectorId: CONNECTOR_ID,
  operationKey: 'check_availability',
  displayName: 'Check availability',
  method: 'POST',
  path: '/freeBusy',
  parameters: [
    { name: 'calendarId', in: 'query', required: true, type: 'string' },
    { name: 'timeMin', in: 'query', required: true, type: 'string' },
    { name: 'timeMax', in: 'query', required: true, type: 'string' },
  ],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/calendar'] },
  chain: [
    {
      method: 'POST',
      urlTemplate: 'https://www.googleapis.com/calendar/v3/freeBusy',
      bodyTemplate: {
        timeMin: '{timeMin}',
        timeMax: '{timeMax}',
        items: [{ id: '{calendarId}' }],
      },
    },
  ],
  sourceOperationIds: [],
  alwaysOnForConnector: true,
  lifecycle: { status: 'approved' },
  catalogVersion: CATALOG_VERSION,
});

// respond_to_event (RSVP) — real Calendar API has no dedicated "respond" endpoint; the only
// correct way is: fetch the event's full attendee list, change ONLY my own entry's
// responseStatus, then PATCH the WHOLE list back (sending just my entry would silently erase
// every other invitee — confirmed by Calendar's events.patch semantics for array fields).
// Needs the new `updateListEntry` step + the executor's {callerEmail} (who this call is
// really running as) — proven first against a mock (_test_chain_operations.py, checks #6-7)
// before being approved here.
await putCatalogOperation({
  connectorId: CONNECTOR_ID,
  operationKey: 'respond_to_event',
  displayName: 'Respond to event invitation',
  method: 'PATCH',
  path: '',
  parameters: [
    { name: 'calendarId', in: 'query', required: true, type: 'string' },
    { name: 'eventId', in: 'query', required: true, type: 'string' },
    { name: 'status', in: 'query', required: true, type: 'string' }, // "accepted" | "declined" | "tentative"
  ],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/calendar'] },
  chain: [
    {
      method: 'GET',
      urlTemplate: 'https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events/{eventId}',
      extracts: [{ path: 'attendees', bindAs: 'attendees' }],
    },
    {
      updateListEntry: {
        listVar: 'attendees',
        matchField: 'email',
        matchValue: '{callerEmail}',
        setField: 'responseStatus',
        setValue: '{status}',
        bindAs: 'updatedAttendees',
      },
    },
    {
      method: 'PATCH',
      urlTemplate: 'https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events/{eventId}?sendUpdates=all',
      bodyTemplate: { attendees: '{updatedAttendees}' },
    },
  ],
  sourceOperationIds: [],
  alwaysOnForConnector: true,
  lifecycle: { status: 'approved' },
  catalogVersion: CATALOG_VERSION,
});

console.log('Added 2 always-on Calendar operations: check_availability, respond_to_event.');
process.exit(0);
