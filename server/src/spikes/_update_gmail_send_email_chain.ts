/**
 * Replaces Gmail's `send_email` (SendEmailV2) from `candidate` with a real, working,
 * database-driven definition — same "chain" + `mimeMessage` mechanism already proven for
 * create_draft/update_draft/reply_to_email.
 *
 * Confirmed live 2026-10-22: the OLD definition made the MODEL itself construct a full RFC
 * 2822 MIME message and base64url-encode it into a single opaque `body` object parameter.
 * The model got this wrong and Gmail rejected it with "Invalid JSON payload received." This
 * was the exact "higher risk" design flagged as a known weak point when send_email was first
 * seeded (see the comment above its entry in _prep_seed_google_connectors_catalog.ts) — now
 * fixed the same way reply_to_email was: the executor assembles the MIME message from plain
 * `to`/`subject`/`body` model arguments, so the model never touches MIME or base64 directly.
 *
 * `messages.send`'s request body is `{"raw": "<base64url>"}` at the TOP level (unlike
 * drafts.create/update, which need it nested under `message.raw`) — so `mimeMessage` is used
 * here with no `rawField` override, which defaults to the flat `raw` key.
 *
 * Proven first against the mocked executor (scripts/_test_chain_operations.py's existing
 * mimeMessage checks cover this same code path) before being approved here — marked
 * `approved` as an informed risk acceptance for live testing, consistent with every other
 * chain operation approved tonight.
 *
 *   npx tsx src/spikes/_update_gmail_send_email_chain.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { putCatalogOperation } from '../db/repos/connectorCatalog.js';

const CONNECTOR_ID = 'shared_gmail';
const CATALOG_VERSION = 1;

await connectMongo();

await putCatalogOperation({
  connectorId: CONNECTOR_ID,
  operationKey: 'send_email',
  displayName: 'Send email (V2)',
  method: 'POST',
  path: '',
  parameters: [
    { name: 'userId', in: 'query', required: true, type: 'string' },
    { name: 'to', in: 'query', required: true, type: 'string' },
    { name: 'subject', in: 'query', required: true, type: 'string' },
    { name: 'body', in: 'query', required: true, type: 'string' },
  ],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/gmail.modify'] },
  chain: [
    {
      method: 'POST',
      urlTemplate: 'https://gmail.googleapis.com/gmail/v1/users/{userId}/messages/send',
      bodyTemplate: {},
      mimeMessage: { to: '{to}', subject: '{subject}', body: '{body}' },
    },
  ],
  sourceOperationIds: ['SendEmailV2'],
  lifecycle: { status: 'approved' },
  catalogVersion: CATALOG_VERSION,
});

console.log('Updated Gmail send_email (SendEmailV2) from candidate -> approved, chain-executed.');
process.exit(0);
