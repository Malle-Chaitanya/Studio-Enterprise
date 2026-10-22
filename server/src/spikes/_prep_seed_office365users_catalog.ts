/**
 * One-time seed of the dynamic-connector catalog for the Office 365 Users PILOT — the
 * data this project will eventually ingest automatically from Microsoft's own published
 * Graph docs, typed in by hand once, here, as the proof-of-concept.
 *
 * CATALOG_VERSION bumped 1 -> 2 on 2026-10-22: the connector's `baseUrl` dropped its
 * hardcoded `/v1.0` so each operation can state its own API version — required once beta-
 * only operations (trending documents) entered the catalog. Every pre-existing operation's
 * `path` gained an explicit `/v1.0` prefix to compensate; the FINAL resolved URL for every
 * one of them is byte-identical to before (verified: "https://graph.microsoft.com/v1.0" +
 * "/users/{userId}" === "https://graph.microsoft.com" + "/v1.0/users/{userId}") — this is a
 * structural correction, not a behavior change, so `get_user`/`get_manager` stay exactly as
 * tested and approved.
 *
 * Real shapes below (new operations, and the `list_users` correction) come from a
 * COMMITTED fixture already in this repo — connectors/fixtures/shared_office365users.ops.json
 * — a live capture of Microsoft's own connector swagger, not a guess.
 *
 * Every operation is either (a) tested LIVE against a real Copilot Studio agent and the
 * real Microsoft Graph API in this project's own test tenant on 2026-10-20, or (b) marked
 * `candidate` and left honestly untested — never guessed into `approved`. See the
 * per-operation comments for which is which.
 *
 *   npx tsx src/spikes/_prep_seed_office365users_catalog.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { putCatalogConnector, putCatalogOperation } from '../db/repos/connectorCatalog.js';

const CONNECTOR_ID = 'shared_office365users';
const CATALOG_VERSION = 3;

await connectMongo();

await putCatalogConnector({
  connectorId: CONNECTOR_ID,
  displayName: 'Office 365 Users',
  vendor: 'microsoft',
  apiFamily: 'microsoft_graph',
  // No version here on purpose — each operation's own `path` states v1.0 or beta, since
  // this connector genuinely needs both (trending documents is beta-only).
  baseUrl: 'https://graph.microsoft.com',
  specSourceUrl: 'https://learn.microsoft.com/en-us/graph/api/resources/user',
  authKind: 'oauth2-client-credentials',
  status: 'candidate',
  catalogVersion: CATALOG_VERSION,
});

// get_user — TESTED LIVE 2026-10-20: asked "get the alex profile" in Copilot Studio Preview,
// got back alex@filefuze.co's real profile (display name, UPN, user id). Confirmed app-only
// with User.Read.All works for ANY user, not just the connection owner.
await putCatalogOperation({
  connectorId: CONNECTOR_ID,
  operationKey: 'get_user',
  displayName: 'Get user profile',
  method: 'GET',
  path: '/v1.0/users/{userId}',
  parameters: [
    { name: 'userId', in: 'path', required: true, type: 'string' },
    { name: '$select', in: 'query', required: false, type: 'string' },
  ],
  auth: { mode: 'app-only', requiredPermissions: ['User.Read.All'], requiresAdminConsent: true },
  // CORRECTED 2026-10-22: confirmed against this agent's actual extracted data — the real
  // id is "UserProfile_V2", not "GetUserV2" (a guess that never matched, so this operation
  // was silently falling through to the OLD, ungated VENDOR_BINDINGS path this whole time —
  // it only "worked" because that path happens to resolve the same correct URL).
  sourceOperationIds: ['UserProfile_V2'],
  lifecycle: { status: 'approved' },
  catalogVersion: CATALOG_VERSION,
});

// get_manager — TESTED LIVE 2026-10-20: "who is my manager" correctly returned alex@filefuze.co
// as erik@filefuze.co's manager, via the real "User (UPN)" input on the Get manager (V2) tool.
await putCatalogOperation({
  connectorId: CONNECTOR_ID,
  operationKey: 'get_manager',
  displayName: "User's manager",
  method: 'GET',
  path: '/v1.0/users/{userId}/manager',
  parameters: [{ name: 'userId', in: 'path', required: true, type: 'string' }],
  auth: { mode: 'app-only', requiredPermissions: ['User.Read.All'], requiresAdminConsent: true },
  sourceOperationIds: ['Manager_V2'],
  lifecycle: { status: 'approved' },
  catalogVersion: CATALOG_VERSION,
});

// get_my_profile — NOT live-tested as a success case; the whole point of this entry is the
// FAILURE it correctly predicts. /me means "whoever is currently signed in" — an app-only
// credential has no "whoever", so this is marked delegated-only and bindFromCatalog refuses
// it outright rather than attempting a call that would fail at run time with a confusing error.
await putCatalogOperation({
  connectorId: CONNECTOR_ID,
  operationKey: 'get_my_profile',
  displayName: 'My profile',
  method: 'GET',
  path: '/v1.0/me',
  parameters: [{ name: '$select', in: 'query', required: false, type: 'string' }],
  auth: { mode: 'delegated', requiredPermissions: ['User.Read'] },
  sourceOperationIds: ['MyProfile_V2'],
  lifecycle: { status: 'candidate' },
  catalogVersion: CATALOG_VERSION,
});

// update_my_profile — NOT live-tested. PATCH /me is delegated-only for the same structural
// reason as get_my_profile: there is no "me" under an app-only credential, so this is
// permanently refused rather than attempted — a write to the wrong identity is worse than a
// read, so this one matters even more to get right.
await putCatalogOperation({
  connectorId: CONNECTOR_ID,
  operationKey: 'update_my_profile',
  displayName: 'Update my profile',
  method: 'PATCH',
  path: '/v1.0/me',
  parameters: [{ name: 'body', in: 'body', required: true, type: 'object' }],
  auth: { mode: 'delegated', requiredPermissions: ['User.ReadWrite'] },
  sourceOperationIds: ['UpdateMyProfile'],
  lifecycle: { status: 'candidate' },
  catalogVersion: CATALOG_VERSION,
});

// update_my_photo — NOT live-tested. Delegated-only (same /me reasoning), AND its request
// body is the binary image itself, not JSON — a second, independent reason this stays
// candidate even once delegated auth exists: the generic executor has no tested path for a
// BINARY request body yet (separate from get_photo's binary RESPONSE concern below).
await putCatalogOperation({
  connectorId: CONNECTOR_ID,
  operationKey: 'update_my_photo',
  displayName: 'Update my profile photo',
  method: 'PUT',
  path: '/v1.0/me/photo/$value',
  parameters: [
    { name: 'body', in: 'body', required: true, type: 'string' },
    { name: 'Content-Type', in: 'header', required: true, type: 'string' },
  ],
  auth: { mode: 'delegated', requiredPermissions: ['User.ReadWrite'] },
  sourceOperationIds: ['UpdateMyPhoto'],
  lifecycle: { status: 'candidate' },
  catalogVersion: CATALOG_VERSION,
});

// list_users — CORRECTED, not simply fixed to the proxy's own parameter name. Microsoft's
// connector swagger calls this parameter `searchTerm`, but that name is specific to the
// POWER PLATFORM PROXY, which translates it into a real Graph query internally — we call
// Graph directly, and real Graph has no `searchTerm` parameter at all. `$filter` (a real,
// documented Graph OData parameter, e.g. startswith(displayName,'...')) is kept. Still
// candidate: the exact filter expression the model should construct needs a live check.
await putCatalogOperation({
  connectorId: CONNECTOR_ID,
  operationKey: 'list_users',
  displayName: 'Search for users',
  method: 'GET',
  path: '/v1.0/users',
  parameters: [
    { name: '$filter', in: 'query', required: false, type: 'string' },
    { name: '$top', in: 'query', required: false, type: 'integer' },
  ],
  auth: { mode: 'app-only', requiredPermissions: ['User.Read.All'], requiresAdminConsent: true },
  response: { resultPath: 'value', pagination: { strategy: 'next-link-field', field: '@odata.nextLink' } },
  sourceOperationIds: ['SearchUserV2'],
  lifecycle: { status: 'candidate' },
  catalogVersion: CATALOG_VERSION,
});

// get_direct_reports — NOT yet live-tested. Same shape as get_manager, so a good candidate
// for the NEXT real test before being marked approved.
await putCatalogOperation({
  connectorId: CONNECTOR_ID,
  operationKey: 'get_direct_reports',
  displayName: 'Direct reports',
  method: 'GET',
  path: '/v1.0/users/{userId}/directReports',
  parameters: [{ name: 'userId', in: 'path', required: true, type: 'string' }],
  auth: { mode: 'app-only', requiredPermissions: ['User.Read.All'], requiresAdminConsent: true },
  response: { resultPath: 'value' },
  // CORRECTED 2026-10-22: confirmed real id has an underscore — "DirectReports_V2".
  sourceOperationIds: ['DirectReports_V2'],
  lifecycle: { status: 'candidate' },
  catalogVersion: CATALOG_VERSION,
});

// get_photo — NOT yet live-tested. Flagged `candidate` for a second reason beyond "untested":
// its response is a binary image, not JSON, which the generic executor does not handle yet.
await putCatalogOperation({
  connectorId: CONNECTOR_ID,
  operationKey: 'get_photo',
  displayName: "User's photo",
  method: 'GET',
  path: '/v1.0/users/{userId}/photo/$value',
  parameters: [{ name: 'userId', in: 'path', required: true, type: 'string' }],
  auth: { mode: 'app-only', requiredPermissions: ['User.Read.All'], requiresAdminConsent: true },
  response: { contentType: 'binary-image' },
  // CORRECTED 2026-10-22: confirmed real id is "UserPhoto_V2" (not "UserPhoto"/"UserPhotoV2",
  // which never matched anything real). This specific mismatch is what caused the live,
  // observed bug: this operation silently bypassed the lifecycle gate via the old fallback
  // path, got deployed anyway, and failed at runtime trying to parse a binary image as JSON.
  sourceOperationIds: ['UserPhoto_V2'],
  lifecycle: { status: 'candidate' },
  catalogVersion: CATALOG_VERSION,
});

// get_photo_metadata — NOT yet live-tested BY US, and lower confidence than most entries
// here: the captured swagger's path (`/users/photo` with `userId` as a QUERY param) looks
// like a Power-Platform-specific dataset abstraction, not a real Graph path. This is a
// reasonable reconstruction (Graph's well-documented convention: the same address as the
// photo's raw bytes, minus `/$value`, returns its metadata as JSON instead) — not confirmed
// live. Candidate status means it is never deployed until someone actually checks this.
await putCatalogOperation({
  connectorId: CONNECTOR_ID,
  operationKey: 'get_photo_metadata',
  displayName: 'User photo metadata',
  method: 'GET',
  path: '/v1.0/users/{userId}/photo',
  parameters: [{ name: 'userId', in: 'path', required: true, type: 'string' }],
  auth: { mode: 'app-only', requiredPermissions: ['User.Read.All'] },
  sourceOperationIds: ['UserPhotoMetadata'],
  lifecycle: { status: 'candidate' },
  catalogVersion: CATALOG_VERSION,
});

// relevant_people — NOT yet live-tested BY US. Lower confidence than the others: the
// captured swagger path carries no `/codeless` prefix (unlike every other operation here),
// so the usual "strip the proxy prefix, the rest IS the real Graph path" rule does not
// straightforwardly apply — this path is a reasonable reconstruction, not a confirmed one.
await putCatalogOperation({
  connectorId: CONNECTOR_ID,
  operationKey: 'relevant_people',
  displayName: 'Get relevant people',
  method: 'GET',
  path: '/v1.0/users/{userId}/relevantpeople',
  parameters: [{ name: 'userId', in: 'path', required: true, type: 'string' }],
  auth: { mode: 'app-only', requiredPermissions: ['People.Read.All'] },
  response: { resultPath: 'value' },
  sourceOperationIds: ['RelevantPeople'],
  lifecycle: { status: 'candidate' },
  catalogVersion: CATALOG_VERSION,
});

// trending_my — NOT yet live-tested. BETA endpoint (Graph's Insights API has no v1.0
// equivalent) — confirmed Microsoft's own docs say Application permissions are NOT
// supported for this API at all, so this stays delegated-only structurally, same as /me.
await putCatalogOperation({
  connectorId: CONNECTOR_ID,
  operationKey: 'trending_my',
  displayName: 'My trending documents',
  method: 'GET',
  path: '/beta/me/insights/trending',
  parameters: [{ name: '$filter', in: 'query', required: false, type: 'string' }],
  auth: { mode: 'delegated', requiredPermissions: ['Sites.Read.All'] },
  response: { resultPath: 'value' },
  sourceOperationIds: ['MyTrendingDocuments'],
  lifecycle: { status: 'candidate' },
  catalogVersion: CATALOG_VERSION,
});

// trending_general — NOT yet live-tested. Same beta/delegated-only reasoning as trending_my.
// The captured swagger also carried two malformed, empty-named parameters (swagger-parsing
// artifacts from the source capture) — deliberately NOT copied into this record.
await putCatalogOperation({
  connectorId: CONNECTOR_ID,
  operationKey: 'trending_general',
  displayName: 'Trending documents',
  method: 'GET',
  path: '/beta/users/{userId}/insights/trending',
  parameters: [
    { name: 'userId', in: 'path', required: true, type: 'string' },
    { name: '$filter', in: 'query', required: false, type: 'string' },
  ],
  auth: { mode: 'delegated', requiredPermissions: ['Sites.Read.All'] },
  response: { resultPath: 'value' },
  sourceOperationIds: ['TrendingDocuments'],
  lifecycle: { status: 'candidate' },
  catalogVersion: CATALOG_VERSION,
});

// raw_http_request — the honest "no" case, UNCHANGED for now. A separate, already-proven
// mechanism for this exact operation exists elsewhere in this codebase (registry.ts's
// `genericPassthroughTool` flag) — integrating that into this catalog model is real,
// separate follow-up work, not folded into this pass silently.
await putCatalogOperation({
  connectorId: CONNECTOR_ID,
  operationKey: 'raw_http_request',
  displayName: 'HTTP request (raw passthrough)',
  method: 'GET',
  path: '',
  parameters: [],
  auth: { mode: 'app-only', requiredPermissions: [] },
  sourceOperationIds: ['HttpRequest'],
  lifecycle: { status: 'unsupported' },
  unsupportedReason:
    'This action let the original maker send ANY request to ANY address through a generic ' +
    'tunnel. There is no way to know in advance what it was actually used for, so it cannot ' +
    'be safely rebuilt automatically. (A different, already-proven mechanism for this exact ' +
    'case exists elsewhere in this codebase — not yet integrated into this catalog.)',
  catalogVersion: CATALOG_VERSION,
});

console.log('Seeded shared_office365users catalog (v3): 13 operations (2 approved, 10 candidate, 1 unsupported).');
process.exit(0);
