/**
 * Replaces Gmail's `reply_to_email` (ReplyToV2) from `unsupported` with a real, working,
 * database-driven definition — using the SAME "chain" mechanism built for Drive, plus two
 * new, equally generic capabilities it needed: extracting a named header out of a
 * `[{name,value}]`-shaped list (Gmail's MIME `payload.headers`), and assembling + base64url-
 * encoding a real RFC 2822 message (`ChainStep.mimeMessage`). Neither is Gmail-specific code
 * — both are declarative, reusable by any future connector shaped the same way.
 *
 * Confirmed against Google's own Gmail API docs: a correct threaded reply genuinely requires
 * reading the original message first (for its real thread id and RFC 2822 Message-ID header
 * — NOT the same as Gmail's own internal message id) — there is no single-call way to do
 * this, confirmed directly from Google's sending guide, not assumed.
 *
 * Proven first against a mocked executor (scripts/_test_chain_operations.py, 18/18 passing,
 * including 9 new checks specific to this operation) before being approved here — same
 * discipline as every other approval tonight: marked `approved` as an explicit, informed risk
 * acceptance for live testing, not because it was proven against a real Gmail account yet.
 *
 *   npx tsx src/spikes/_update_gmail_reply_chain.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { putCatalogOperation } from '../db/repos/connectorCatalog.js';

const CONNECTOR_ID = 'shared_gmail';
const CATALOG_VERSION = 1;

await connectMongo();

await putCatalogOperation({
  connectorId: CONNECTOR_ID,
  operationKey: 'reply_to_email',
  displayName: 'Reply to email (V2)',
  method: 'POST',
  path: '',
  parameters: [
    { name: 'userId', in: 'query', required: true, type: 'string' }, // "me" for the impersonated mailbox
    { name: 'messageId', in: 'query', required: true, type: 'string' },
    { name: 'body', in: 'query', required: true, type: 'string' },
  ],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/gmail.modify'] },
  chain: [
    {
      // Read the ORIGINAL message first — its real thread id and its RFC 2822 Message-ID
      // (a different value from Gmail's own "id") are both required for Gmail to thread the
      // reply correctly instead of sending a new, unthreaded email that only looks like one.
      method: 'GET',
      urlTemplate: 'https://gmail.googleapis.com/gmail/v1/users/{userId}/messages/{messageId}?format=metadata',
      extracts: [
        { path: 'threadId', bindAs: 'threadId' },
        { path: 'payload.headers', headerName: 'Message-ID', bindAs: 'origMessageId' },
        { path: 'payload.headers', headerName: 'Subject', bindAs: 'origSubject' },
        { path: 'payload.headers', headerName: 'From', bindAs: 'origFrom' },
      ],
    },
    {
      method: 'POST',
      urlTemplate: 'https://gmail.googleapis.com/gmail/v1/users/{userId}/messages/send',
      bodyTemplate: { threadId: '{threadId}' },
      mimeMessage: {
        to: '{origFrom}', // replies to whoever sent the original — matches real reply behaviour
        subject: 'Re: {origSubject}',
        inReplyTo: '{origMessageId}',
        references: '{origMessageId}',
        body: '{body}',
      },
    },
  ],
  sourceOperationIds: ['ReplyToV2'],
  lifecycle: { status: 'approved' },
  catalogVersion: CATALOG_VERSION,
});

console.log('Updated Gmail reply_to_email (ReplyToV2) from unsupported -> approved, chain-executed.');
process.exit(0);
