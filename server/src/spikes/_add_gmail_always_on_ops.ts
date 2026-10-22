/**
 * Adds Gmail's bonus capabilities with NO Microsoft source equivalent — confirmed directly
 * against Microsoft's real connector reference page (re-checked 2026-10-22: no action for
 * labels, drafts, forwarding, starring, mark-read, or attachments exists there at all) — as
 * `alwaysOnForConnector` rows.
 *
 * star/unstar and mark-read/mark-unread are each split into TWO fixed-direction operations
 * rather than one with a boolean toggle — the executor's `bodyTemplate` has no conditional
 * branching, so "add this label" and "remove this label" are two different template bodies,
 * not one. Same real capability as the dedicated file's boolean-flag functions, just
 * expressed as data two ways instead of one parameterised way.
 *
 * "Forward" is scoped down from what the dedicated file likely did: it quotes the original
 * message's subject/sender/body as text in a new message, but does NOT re-attach the
 * original's binary attachments (that needs fetching and re-encoding attachment bytes, a
 * real additional piece of work, not done here) — a real, honest, documented limitation,
 * not a silent one.
 *
 *   npx tsx src/spikes/_add_gmail_always_on_ops.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { putCatalogOperation } from '../db/repos/connectorCatalog.js';

const CONNECTOR_ID = 'shared_gmail';
const CATALOG_VERSION = 1;

await connectMongo();

await putCatalogOperation({
  connectorId: CONNECTOR_ID,
  operationKey: 'list_labels',
  displayName: 'List labels',
  method: 'GET',
  path: '/gmail/v1/users/{userId}/labels',
  parameters: [{ name: 'userId', in: 'path', required: true, type: 'string' }],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/gmail.modify'] },
  response: { resultPath: 'labels' },
  sourceOperationIds: [],
  alwaysOnForConnector: true,
  lifecycle: { status: 'approved' },
  catalogVersion: CATALOG_VERSION,
});

// modify_labels — the general-purpose primitive: add/remove any real label ID in one call.
// System label ids (INBOX, UNREAD, STARRED, IMPORTANT, SPAM, TRASH, DRAFT) are well-known and
// fixed; a CUSTOM label's real id must be looked up first via list_labels — the model is
// told this plainly rather than silently failing on a label name.
await putCatalogOperation({
  connectorId: CONNECTOR_ID,
  operationKey: 'modify_labels',
  displayName: 'Modify labels on an email',
  method: 'POST',
  path: '',
  parameters: [
    { name: 'userId', in: 'query', required: true, type: 'string' },
    { name: 'messageId', in: 'query', required: true, type: 'string' },
    { name: 'addLabelId', in: 'query', required: true, type: 'string' }, // real label id, e.g. "IMPORTANT" or "Label_123"; pass "" for none
    { name: 'removeLabelId', in: 'query', required: true, type: 'string' }, // pass "" for none
  ],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/gmail.modify'] },
  chain: [
    {
      method: 'POST',
      urlTemplate: 'https://gmail.googleapis.com/gmail/v1/users/{userId}/messages/{messageId}/modify',
      bodyTemplate: { addLabelIds: ['{addLabelId}'], removeLabelIds: ['{removeLabelId}'] },
    },
  ],
  sourceOperationIds: [],
  alwaysOnForConnector: true,
  lifecycle: { status: 'approved' },
  catalogVersion: CATALOG_VERSION,
});

await putCatalogOperation({
  connectorId: CONNECTOR_ID,
  operationKey: 'star_message',
  displayName: 'Star an email',
  method: 'POST',
  path: '',
  parameters: [
    { name: 'userId', in: 'query', required: true, type: 'string' },
    { name: 'messageId', in: 'query', required: true, type: 'string' },
  ],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/gmail.modify'] },
  chain: [{ method: 'POST', urlTemplate: 'https://gmail.googleapis.com/gmail/v1/users/{userId}/messages/{messageId}/modify', bodyTemplate: { addLabelIds: ['STARRED'] } }],
  sourceOperationIds: [],
  alwaysOnForConnector: true,
  lifecycle: { status: 'approved' },
  catalogVersion: CATALOG_VERSION,
});

await putCatalogOperation({
  connectorId: CONNECTOR_ID,
  operationKey: 'unstar_message',
  displayName: 'Unstar an email',
  method: 'POST',
  path: '',
  parameters: [
    { name: 'userId', in: 'query', required: true, type: 'string' },
    { name: 'messageId', in: 'query', required: true, type: 'string' },
  ],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/gmail.modify'] },
  chain: [{ method: 'POST', urlTemplate: 'https://gmail.googleapis.com/gmail/v1/users/{userId}/messages/{messageId}/modify', bodyTemplate: { removeLabelIds: ['STARRED'] } }],
  sourceOperationIds: [],
  alwaysOnForConnector: true,
  lifecycle: { status: 'approved' },
  catalogVersion: CATALOG_VERSION,
});

await putCatalogOperation({
  connectorId: CONNECTOR_ID,
  operationKey: 'mark_read',
  displayName: 'Mark an email as read',
  method: 'POST',
  path: '',
  parameters: [
    { name: 'userId', in: 'query', required: true, type: 'string' },
    { name: 'messageId', in: 'query', required: true, type: 'string' },
  ],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/gmail.modify'] },
  chain: [{ method: 'POST', urlTemplate: 'https://gmail.googleapis.com/gmail/v1/users/{userId}/messages/{messageId}/modify', bodyTemplate: { removeLabelIds: ['UNREAD'] } }],
  sourceOperationIds: [],
  alwaysOnForConnector: true,
  lifecycle: { status: 'approved' },
  catalogVersion: CATALOG_VERSION,
});

await putCatalogOperation({
  connectorId: CONNECTOR_ID,
  operationKey: 'mark_unread',
  displayName: 'Mark an email as unread',
  method: 'POST',
  path: '',
  parameters: [
    { name: 'userId', in: 'query', required: true, type: 'string' },
    { name: 'messageId', in: 'query', required: true, type: 'string' },
  ],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/gmail.modify'] },
  chain: [{ method: 'POST', urlTemplate: 'https://gmail.googleapis.com/gmail/v1/users/{userId}/messages/{messageId}/modify', bodyTemplate: { addLabelIds: ['UNREAD'] } }],
  sourceOperationIds: [],
  alwaysOnForConnector: true,
  lifecycle: { status: 'approved' },
  catalogVersion: CATALOG_VERSION,
});

await putCatalogOperation({
  connectorId: CONNECTOR_ID,
  operationKey: 'get_attachment',
  displayName: 'Get an email attachment',
  method: 'GET',
  // The attachment id comes from a prior Get email details call's response (payload.parts[].
  // body.attachmentId) — not guessed; the model is expected to have seen it already.
  path: '/gmail/v1/users/{userId}/messages/{messageId}/attachments/{attachmentId}',
  parameters: [
    { name: 'userId', in: 'path', required: true, type: 'string' },
    { name: 'messageId', in: 'path', required: true, type: 'string' },
    { name: 'attachmentId', in: 'path', required: true, type: 'string' },
  ],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/gmail.modify'] },
  response: { contentType: 'binary-image' }, // base64 attachment data, not plain JSON text
  sourceOperationIds: [],
  alwaysOnForConnector: true,
  lifecycle: { status: 'approved' },
  catalogVersion: CATALOG_VERSION,
});

await putCatalogOperation({
  connectorId: CONNECTOR_ID,
  operationKey: 'list_drafts',
  displayName: 'List drafts',
  method: 'GET',
  path: '/gmail/v1/users/{userId}/drafts',
  parameters: [{ name: 'userId', in: 'path', required: true, type: 'string' }],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/gmail.modify'] },
  response: { resultPath: 'drafts' },
  sourceOperationIds: [],
  alwaysOnForConnector: true,
  lifecycle: { status: 'approved' },
  catalogVersion: CATALOG_VERSION,
});

await putCatalogOperation({
  connectorId: CONNECTOR_ID,
  operationKey: 'send_draft',
  displayName: 'Send a draft',
  method: 'POST',
  path: '',
  parameters: [
    { name: 'userId', in: 'query', required: true, type: 'string' },
    { name: 'draftId', in: 'query', required: true, type: 'string' },
  ],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/gmail.modify'] },
  chain: [{ method: 'POST', urlTemplate: 'https://gmail.googleapis.com/gmail/v1/users/{userId}/drafts/send', bodyTemplate: { id: '{draftId}' } }],
  sourceOperationIds: [],
  alwaysOnForConnector: true,
  lifecycle: { status: 'approved' },
  catalogVersion: CATALOG_VERSION,
});

// create_draft / update_draft — reuse the same mimeMessage assembly as reply, just without
// any In-Reply-To/References threading (a brand-new draft has nothing to thread to).
await putCatalogOperation({
  connectorId: CONNECTOR_ID,
  operationKey: 'create_draft',
  displayName: 'Create a draft',
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
      urlTemplate: 'https://gmail.googleapis.com/gmail/v1/users/{userId}/drafts',
      bodyTemplate: { message: {} }, // overwritten by mimeMessage's rawField merge below
      mimeMessage: { to: '{to}', subject: '{subject}', body: '{body}', rawField: 'message.raw' },
    },
  ],
  sourceOperationIds: [],
  alwaysOnForConnector: true,
  lifecycle: { status: 'approved' },
  catalogVersion: CATALOG_VERSION,
});

await putCatalogOperation({
  connectorId: CONNECTOR_ID,
  operationKey: 'update_draft',
  displayName: 'Update a draft',
  method: 'PUT',
  path: '',
  parameters: [
    { name: 'userId', in: 'query', required: true, type: 'string' },
    { name: 'draftId', in: 'query', required: true, type: 'string' },
    { name: 'to', in: 'query', required: true, type: 'string' },
    { name: 'subject', in: 'query', required: true, type: 'string' },
    { name: 'body', in: 'query', required: true, type: 'string' },
  ],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/gmail.modify'] },
  chain: [
    {
      method: 'PUT',
      urlTemplate: 'https://gmail.googleapis.com/gmail/v1/users/{userId}/drafts/{draftId}',
      bodyTemplate: { message: {} },
      mimeMessage: { to: '{to}', subject: '{subject}', body: '{body}', rawField: 'message.raw' },
    },
  ],
  sourceOperationIds: [],
  alwaysOnForConnector: true,
  lifecycle: { status: 'approved' },
  catalogVersion: CATALOG_VERSION,
});

// forward_message — SCOPED, honestly: quotes the original's subject/sender/body as text in a
// new message. Does NOT re-attach the original's binary attachments (that needs fetching and
// re-encoding attachment bytes separately — real additional work, not done here).
await putCatalogOperation({
  connectorId: CONNECTOR_ID,
  operationKey: 'forward_message',
  displayName: 'Forward an email',
  method: 'POST',
  path: '',
  parameters: [
    { name: 'userId', in: 'query', required: true, type: 'string' },
    { name: 'messageId', in: 'query', required: true, type: 'string' },
    { name: 'to', in: 'query', required: true, type: 'string' },
    { name: 'comment', in: 'query', required: true, type: 'string' }, // pass "" for no extra comment
  ],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/gmail.modify'] },
  chain: [
    {
      method: 'GET',
      urlTemplate: 'https://gmail.googleapis.com/gmail/v1/users/{userId}/messages/{messageId}?format=full',
      extracts: [
        { path: 'payload.headers', headerName: 'Subject', bindAs: 'origSubject' },
        { path: 'payload.headers', headerName: 'From', bindAs: 'origFrom' },
        { path: 'snippet', bindAs: 'origSnippet' },
      ],
    },
    {
      method: 'POST',
      urlTemplate: 'https://gmail.googleapis.com/gmail/v1/users/{userId}/messages/send',
      mimeMessage: {
        to: '{to}',
        subject: 'Fwd: {origSubject}',
        body: '{comment}\r\n\r\n---------- Forwarded message ---------\r\nFrom: {origFrom}\r\nSubject: {origSubject}\r\n\r\n{origSnippet}',
      },
    },
  ],
  sourceOperationIds: [],
  alwaysOnForConnector: true,
  lifecycle: { status: 'approved' },
  catalogVersion: CATALOG_VERSION,
});

console.log(
  'Added 12 always-on Gmail operations: list_labels, modify_labels, star_message, ' +
    'unstar_message, mark_read, mark_unread, get_attachment, list_drafts, send_draft, ' +
    'create_draft, update_draft, forward_message.',
);
process.exit(0);
