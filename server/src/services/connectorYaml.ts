/**
 * connectorYaml.ts — Tier 1 rule-based YAML generators for each known
 * connector → Google equivalent mapping (and keep-MS paths).
 *
 * Each generator returns a properly indented Cloud Workflows step string that
 * plugs directly into the flow YAML assembled by flowMapper.ts.
 *
 * Cloud Workflows expression syntax uses ${...} — within TypeScript template
 * literals these are escaped as \${...} so they are emitted verbatim.
 */

import type { FlowAction } from '../types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Convert an arbitrary string to a valid snake_case Cloud Workflows step name. */
function toSnakeCase(s: string): string {
  return (
    s
      .replace(/[^a-zA-Z0-9_]/g, '_')
      .replace(/_{2,}/g, '_')
      .replace(/^_|_$/g, '')
      .toLowerCase() || 'step'
  );
}

// ── Google Chat (Teams → Chat) ────────────────────────────────────────────────

function buildGoogleChat(
  stepName: string,
  _action: FlowAction,
  _customerAnswers: Record<string, string>,
): string {
  return [
    `    - ${stepName}:`,
    `        call: http.post`,
    `        args:`,
    `          url: \${"https://chat.googleapis.com/v1/spaces/" + args.chat_space_id + "/messages"}`,
    `          auth:`,
    `            type: OAuth2`,
    `          body:`,
    `            text: \${args.message_text}`,
    `        result: ${stepName}_result`,
  ].join('\n');
}

// ── Google Drive (SharePoint / OneDrive → Drive) ──────────────────────────────

function buildGoogleDriveUpload(
  stepName: string,
  _action: FlowAction,
  _customerAnswers: Record<string, string>,
): string {
  return [
    `    - ${stepName}:`,
    `        call: http.post`,
    `        args:`,
    `          url: \${"https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true"}`,
    `          auth:`,
    `            type: OAuth2`,
    `          body:`,
    `            name: \${args.file_name}`,
    `            parents: [\${args.drive_folder_id}]`,
    `        result: ${stepName}_result`,
  ].join('\n');
}

function buildGoogleDriveList(
  stepName: string,
  _action: FlowAction,
  _customerAnswers: Record<string, string>,
): string {
  return [
    `    - ${stepName}:`,
    `        call: http.get`,
    `        args:`,
    `          url: \${"https://www.googleapis.com/drive/v3/files?q=%27" + args.drive_folder_id + "%27+in+parents"}`,
    `          auth:`,
    `            type: OAuth2`,
    `        result: ${stepName}_result`,
  ].join('\n');
}

/** Pick upload vs. list based on operationId heuristic. */
function buildGoogleDrive(
  stepName: string,
  action: FlowAction,
  customerAnswers: Record<string, string>,
): string {
  const op = action.operationId?.toLowerCase() ?? '';
  if (op.includes('list') || op.includes('get') || op.includes('items')) {
    return buildGoogleDriveList(stepName, action, customerAnswers);
  }
  return buildGoogleDriveUpload(stepName, action, customerAnswers);
}

// ── Gmail (Office 365 / Outlook → Gmail) ─────────────────────────────────────

function buildGmail(
  stepName: string,
  _action: FlowAction,
  _customerAnswers: Record<string, string>,
): string {
  return [
    `    - ${stepName}:`,
    `        call: http.post`,
    `        args:`,
    `          url: https://gmail.googleapis.com/gmail/v1/users/me/messages/send`,
    `          auth:`,
    `            type: OAuth2`,
    `          body:`,
    `            raw: \${base64.encode(text.encode("To: " + args.email_to + "\\r\\nSubject: " + args.email_subject + "\\r\\n\\r\\n" + args.email_body))}`,
    `        result: ${stepName}_result`,
  ].join('\n');
}

// ── GCS (Azure Blob → Cloud Storage) ─────────────────────────────────────────

function buildGcs(
  stepName: string,
  _action: FlowAction,
  _customerAnswers: Record<string, string>,
): string {
  return [
    `    - ${stepName}:`,
    `        call: http.post`,
    `        args:`,
    `          url: \${"https://storage.googleapis.com/upload/storage/v1/b/" + args.gcs_bucket + "/o?uploadType=media&name=" + args.file_name}`,
    `          auth:`,
    `            type: OAuth2`,
    `          body: \${args.file_content}`,
    `        result: ${stepName}_result`,
  ].join('\n');
}

// ── Google Tasks (Planner → Tasks) ───────────────────────────────────────────

function buildGoogleTasks(
  stepName: string,
  _action: FlowAction,
  _customerAnswers: Record<string, string>,
): string {
  return [
    `    - ${stepName}:`,
    `        call: http.post`,
    `        args:`,
    `          url: \${"https://tasks.googleapis.com/tasks/v1/lists/" + args.tasks_list_id + "/tasks"}`,
    `          auth:`,
    `            type: OAuth2`,
    `          body:`,
    `            title: \${args.task_title}`,
    `            notes: \${args.task_notes}`,
    `        result: ${stepName}_result`,
  ].join('\n');
}

// ── Google Sheets (Excel Online → Sheets) ────────────────────────────────────

function buildGoogleSheets(
  stepName: string,
  _action: FlowAction,
  _customerAnswers: Record<string, string>,
): string {
  return [
    `    - ${stepName}:`,
    `        call: http.get`,
    `        args:`,
    `          url: \${"https://sheets.googleapis.com/v4/spreadsheets/" + args.sheets_id + "/values/Sheet1"}`,
    `          auth:`,
    `            type: OAuth2`,
    `        result: ${stepName}_result`,
  ].join('\n');
}

// ── Keep MS — Teams (MS Graph) ────────────────────────────────────────────────

function buildKeepTeams(
  stepName: string,
  _action: FlowAction,
  _customerAnswers: Record<string, string>,
): string {
  return [
    `    - ${stepName}:`,
    `        call: http.post`,
    `        args:`,
    `          url: \${"https://graph.microsoft.com/v1.0/teams/" + args.teams_team_id + "/channels/" + args.teams_channel_id + "/messages"}`,
    `          headers:`,
    `            Authorization: \${"Bearer " + graph_token}`,
    `          body:`,
    `            body:`,
    `              content: \${args.message_text}`,
    `        result: ${stepName}_result`,
  ].join('\n');
}

// ── Keep MS — SharePoint / OneDrive (MS Graph) ────────────────────────────────

function buildKeepSharePoint(
  stepName: string,
  _action: FlowAction,
  _customerAnswers: Record<string, string>,
): string {
  return [
    `    - ${stepName}:`,
    `        call: http.get`,
    `        args:`,
    `          url: \${"https://graph.microsoft.com/v1.0/sites/" + args.sharepoint_site_id + "/lists/" + args.sharepoint_list_id + "/items"}`,
    `          headers:`,
    `            Authorization: \${"Bearer " + graph_token}`,
    `        result: ${stepName}_result`,
  ].join('\n');
}

// ── Keep MS — Office 365 / Outlook (MS Graph sendMail) ───────────────────────

function buildKeepOffice365(
  stepName: string,
  _action: FlowAction,
  _customerAnswers: Record<string, string>,
): string {
  return [
    `    - ${stepName}:`,
    `        call: http.post`,
    `        args:`,
    `          url: \${"https://graph.microsoft.com/v1.0/users/" + args.sender_email + "/sendMail"}`,
    `          headers:`,
    `            Authorization: \${"Bearer " + graph_token}`,
    `            Content-Type: application/json`,
    `          body:`,
    `            message:`,
    `              subject: \${args.email_subject}`,
    `              body:`,
    `                contentType: Text`,
    `                content: \${args.email_body}`,
    `              toRecipients:`,
    `                - emailAddress:`,
    `                    address: \${args.email_to}`,
    `        result: ${stepName}_result`,
  ].join('\n');
}

// ── Tier 3 stub ───────────────────────────────────────────────────────────────

function buildStub(stepName: string, connectorId: string): string {
  const safeName = toSnakeCase(connectorId);
  return [
    `    - ${stepName}:`,
    `        # FLAGGED: connector "${connectorId}" has no automatic mapping`,
    `        # Implement manually using the appropriate API`,
    `        assign:`,
    `          - ${stepName}_skipped: "manual implementation required for ${safeName}"`,
  ].join('\n');
}

// ── Public dispatcher ─────────────────────────────────────────────────────────

/**
 * Build the Cloud Workflows YAML step for a connector action based on the
 * customer's choice.
 *
 * @param connectorId      The PA connector API name (e.g. 'shared_teams').
 * @param choice           Customer answer for `connector_<connectorId>`.
 * @param stepName         Unique step name already deduplicated by the mapper.
 * @param action           The original FlowAction (may inform heuristics).
 * @param customerAnswers  All customer answers (for config fields like bucket name).
 * @returns                Indented YAML string for one workflow step.
 */
export function buildConnectorStep(
  connectorId: string,
  choice: string,
  stepName: string,
  action: FlowAction,
  customerAnswers: Record<string, string>,
): string {
  // ── Google replacements ────────────────────────────────────────────────────
  if (choice === 'google_chat') {
    return buildGoogleChat(stepName, action, customerAnswers);
  }
  if (choice === 'google_drive') {
    return buildGoogleDrive(stepName, action, customerAnswers);
  }
  if (choice === 'gmail') {
    return buildGmail(stepName, action, customerAnswers);
  }
  if (choice === 'gcs') {
    return buildGcs(stepName, action, customerAnswers);
  }
  if (choice === 'google_tasks') {
    return buildGoogleTasks(stepName, action, customerAnswers);
  }
  if (choice === 'google_sheets') {
    return buildGoogleSheets(stepName, action, customerAnswers);
  }

  // ── Keep MS — route by connector family ───────────────────────────────────
  if (choice === 'keep') {
    if (connectorId === 'shared_teams') {
      return buildKeepTeams(stepName, action, customerAnswers);
    }
    if (
      connectorId === 'shared_sharepointonline' ||
      connectorId === 'shared_onedrive'
    ) {
      return buildKeepSharePoint(stepName, action, customerAnswers);
    }
    if (
      connectorId === 'shared_office365' ||
      connectorId === 'shared_outlook'
    ) {
      return buildKeepOffice365(stepName, action, customerAnswers);
    }
    // Generic keep — emit a flagged stub for manual wiring
    return buildStub(stepName, connectorId);
  }

  // ── Tier 3 stub (unknown choice or explicit 'stub') ───────────────────────
  return buildStub(stepName, connectorId);
}
