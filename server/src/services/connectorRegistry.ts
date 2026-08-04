/**
 * Connector Registry — Tier 1 deterministic mappings for known Power Automate
 * connectors to Google equivalents (or keep-MS).
 *
 * Tier 1: rule-based YAML via connectorYaml.ts  (this file drives the lookup)
 * Tier 2: Hermas (LLM) for unknown connectors
 * Tier 3: stub YAML — TODO comment flagged in UI
 */

// ── Public interfaces ─────────────────────────────────────────────────────────

export interface ConfigField {
  /** e.g. 'chat_space_id' */
  key: string;
  /** e.g. 'Google Chat Space ID' */
  label: string;
  /** e.g. 'spaces/XXXXXXXXXX' */
  placeholder: string;
}

export interface ConnectorEntry {
  displayName: string;
  /** null = keep MS connector / no Google equivalent available */
  googleEquivalent: string | null;
  googleDisplayName: string | null;
  requiresConfig: ConfigField[];
  /** 1 = rule-based, 2 = Hermas, 3 = stub */
  tier: 1 | 2 | 3;
}

export interface ConnectorQuestionOption {
  value:
    | 'keep'
    | 'google_chat'
    | 'gmail'
    | 'google_drive'
    | 'gcs'
    | 'google_tasks'
    | 'google_sheets'
    | 'google_calendar'
    | string;
  label: string;
  requiresConfig: ConfigField[];
}

export interface ConnectorQuestion {
  connectorId: string;
  displayName: string;
  options: ConnectorQuestionOption[];
}

// ── Tier 1 Registry ───────────────────────────────────────────────────────────

export const CONNECTOR_REGISTRY: Record<string, ConnectorEntry> = {
  shared_teams: {
    displayName: 'Microsoft Teams',
    googleEquivalent: 'google_chat',
    googleDisplayName: 'Google Chat',
    requiresConfig: [
      {
        key: 'chat_space_id',
        label: 'Google Chat Space ID',
        placeholder: 'spaces/XXXXXXXXXX',
      },
    ],
    tier: 1,
  },

  shared_sharepointonline: {
    displayName: 'SharePoint',
    googleEquivalent: 'google_drive',
    googleDisplayName: 'Google Drive',
    requiresConfig: [
      {
        key: 'drive_folder_id',
        label: 'Google Drive Folder ID',
        placeholder: '1a2B3c4D5e6F...',
      },
    ],
    tier: 1,
  },

  shared_office365: {
    displayName: 'Office 365 Outlook',
    googleEquivalent: 'gmail',
    googleDisplayName: 'Gmail',
    requiresConfig: [
      {
        key: 'gmail_to',
        label: 'Default Gmail recipient address',
        placeholder: 'recipient@example.com',
      },
    ],
    tier: 1,
  },

  shared_onedrive: {
    displayName: 'OneDrive',
    googleEquivalent: 'google_drive',
    googleDisplayName: 'Google Drive',
    requiresConfig: [
      {
        key: 'drive_folder_id',
        label: 'Google Drive Folder ID',
        placeholder: '1a2B3c4D5e6F...',
      },
    ],
    tier: 1,
  },

  shared_azureblob: {
    displayName: 'Azure Blob Storage',
    googleEquivalent: 'gcs',
    googleDisplayName: 'Cloud Storage (GCS)',
    requiresConfig: [
      {
        key: 'gcs_bucket',
        label: 'GCS Bucket Name',
        placeholder: 'my-migration-bucket',
      },
    ],
    tier: 1,
  },

  shared_outlook: {
    displayName: 'Outlook.com',
    googleEquivalent: 'gmail',
    googleDisplayName: 'Gmail',
    requiresConfig: [
      {
        key: 'gmail_to',
        label: 'Default Gmail recipient address',
        placeholder: 'recipient@example.com',
      },
    ],
    tier: 1,
  },

  shared_planner: {
    displayName: 'Microsoft Planner',
    googleEquivalent: 'google_tasks',
    googleDisplayName: 'Google Tasks',
    requiresConfig: [
      {
        key: 'tasks_list_id',
        label: 'Google Tasks List ID',
        placeholder: 'MDAxMTk4...',
      },
    ],
    tier: 1,
  },

  shared_excelonline: {
    displayName: 'Excel Online (Business)',
    googleEquivalent: 'google_sheets',
    googleDisplayName: 'Google Sheets',
    requiresConfig: [
      {
        key: 'sheets_id',
        label: 'Google Sheets Spreadsheet ID',
        placeholder: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms',
      },
    ],
    tier: 1,
  },

  // Dataverse connectors — keep MS, no question needed
  shared_commondataserviceforapps: {
    displayName: 'Microsoft Dataverse',
    googleEquivalent: null,
    googleDisplayName: null,
    requiresConfig: [],
    tier: 1,
  },

  shared_commondataservice: {
    displayName: 'Common Data Service',
    googleEquivalent: null,
    googleDisplayName: null,
    requiresConfig: [],
    tier: 1,
  },
};

// ── Helper predicates ─────────────────────────────────────────────────────────

/** Returns true for connectors that stay on MS Dataverse / no migration needed. */
export function isDataverseConnector(id: string): boolean {
  return (
    id === 'shared_commondataserviceforapps' ||
    id === 'shared_commondataservice'
  );
}

// ── Question generator ────────────────────────────────────────────────────────

/**
 * Build the UI question list for a set of connector API names.
 *
 * - Dataverse connectors are silently skipped (no choice needed).
 * - Tier 1 connectors produce a two-option question: switch to Google or keep MS.
 * - Unknown connectors produce a free-form "keep or custom" question (Tier 2/3).
 */
export function getConnectorQuestions(connectorIds: string[]): ConnectorQuestion[] {
  const questions: ConnectorQuestion[] = [];
  const seen = new Set<string>();

  for (const id of connectorIds) {
    if (seen.has(id)) continue;
    seen.add(id);

    // Dataverse — silent keep, no question
    if (isDataverseConnector(id)) continue;

    const entry = CONNECTOR_REGISTRY[id];

    if (entry) {
      // Tier 1 known connector
      const options: ConnectorQuestionOption[] = [
        {
          value: 'keep',
          label: `Keep as Microsoft — ${entry.displayName} (uses MS Graph via Entra token)`,
          requiresConfig: [],
        },
      ];

      if (entry.googleEquivalent !== null) {
        options.push({
          value: entry.googleEquivalent,
          label: `Replace with ${entry.googleDisplayName ?? entry.googleEquivalent}`,
          requiresConfig: entry.requiresConfig,
        });
      }

      questions.push({
        connectorId: id,
        displayName: entry.displayName,
        options,
      });
    } else {
      // Unknown connector — Tier 2 (Hermas) or Tier 3 (stub)
      questions.push({
        connectorId: id,
        displayName: id,
        options: [
          {
            value: 'keep',
            label: 'Keep — call original endpoint (MS Graph / best-effort)',
            requiresConfig: [],
          },
          {
            value: 'hermas',
            label: 'Let AI (Hermas) determine the best Google equivalent',
            requiresConfig: [],
          },
          {
            value: 'stub',
            label: 'Insert TODO stub — implement manually later',
            requiresConfig: [],
          },
        ],
      });
    }
  }

  return questions;
}

// ── Hermas context builder ────────────────────────────────────────────────────

/**
 * Produces a plain-English summary of connector choices to append to the
 * Hermas generate prompt. Hermas uses this to produce the correct YAML for
 * each connector rather than guessing.
 *
 * @param thirdPartySecrets  Map of connectorId → { field: smSecretId } for
 *   third-party connectors (e.g. HubSpot) whose API keys have been stored in
 *   Secret Manager. Hermas will emit YAML that reads the key from SM at runtime.
 */
export function buildHermasConnectorContext(
  connectorIds: string[],
  customerAnswers: Record<string, string>,
  thirdPartySecrets?: Record<string, Record<string, string>>,
): string {
  if (connectorIds.length === 0) return '';

  const lines: string[] = ['Connector mapping for this flow:'];

  for (const id of connectorIds) {
    const choice = customerAnswers[`connector_${id}`];

    if (isDataverseConnector(id)) {
      lines.push(`- ${id}: Dataverse → keep MS, use Dataverse OData API with Authorization: Bearer \${entra_token}`);
      continue;
    }

    const entry = CONNECTOR_REGISTRY[id];

    // Third-party connector (not in registry) with SM-stored credentials
    if (!entry && choice === 'hermas') {
      const secrets = thirdPartySecrets?.[id];
      if (secrets && Object.keys(secrets).length > 0) {
        const secretLines = Object.entries(secrets)
          .map(([field, secretId]) =>
            `    - ${field}: read from SM secret "${secretId}" via http.get to https://secretmanager.googleapis.com/v1/projects/.../secrets/${secretId}/versions/latest:access with auth.type=OAuth2, decode base64 payload.data`,
          )
          .join('\n');
        lines.push(
          `- ${id}: third-party connector, customer provided credentials stored in Secret Manager.\n` +
          `  Use the following SM secrets to authenticate, then call the connector's REST API:\n${secretLines}\n` +
          `  Generate a Cloud Workflow that reads each secret, constructs the API call, and returns the result.`,
        );
      } else {
        lines.push(
          `- ${id}: unknown third-party connector, customer chose AI-assisted migration.\n` +
          `  Research this connector's public REST API documentation and generate YAML that calls it directly.\n` +
          `  Use a TODO comment if you cannot determine the correct endpoint.`,
        );
      }
      continue;
    }

    if (!choice) {
      if (entry) {
        const hint = entry.googleEquivalent
          ? `known connector, Google equivalent is ${entry.googleDisplayName ?? entry.googleEquivalent}`
          : `known connector, no Google equivalent — keep MS`;
        lines.push(`- ${id}: ${hint} (customer has not chosen yet — use best judgment)`);
      } else {
        lines.push(`- ${id}: unknown connector, use best judgment or HTTP call to original endpoint`);
      }
      continue;
    }

    if (choice === 'keep') {
      lines.push(
        `- ${id}: customer chose keep → use MS Graph API with Authorization: Bearer \${entra_token}`,
      );
      continue;
    }

    // Google replacement
    switch (choice) {
      case 'google_chat': {
        const spaceId = customerAnswers['chat_space_id'] ?? '{args.chat_space_id}';
        lines.push(
          `- ${id}: customer chose google_chat → use https://chat.googleapis.com/v1/spaces/${spaceId}/messages with auth.type=OAuth2`,
        );
        break;
      }
      case 'google_drive': {
        const folderId = customerAnswers['drive_folder_id'] ?? '{args.drive_folder_id}';
        lines.push(
          `- ${id}: customer chose google_drive → use https://www.googleapis.com/drive/v3/files (folder: ${folderId}) with auth.type=OAuth2`,
        );
        break;
      }
      case 'gmail': {
        lines.push(
          `- ${id}: customer chose gmail → use https://gmail.googleapis.com/gmail/v1/users/me/messages/send with auth.type=OAuth2`,
        );
        break;
      }
      case 'gcs': {
        const bucket = customerAnswers['gcs_bucket'] ?? '{args.gcs_bucket}';
        lines.push(
          `- ${id}: customer chose gcs → use https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o with auth.type=OAuth2`,
        );
        break;
      }
      case 'google_tasks': {
        const listId = customerAnswers['tasks_list_id'] ?? '{args.tasks_list_id}';
        lines.push(
          `- ${id}: customer chose google_tasks → use https://tasks.googleapis.com/tasks/v1/lists/${listId}/tasks with auth.type=OAuth2`,
        );
        break;
      }
      case 'google_sheets': {
        const sheetsId = customerAnswers['sheets_id'] ?? '{args.sheets_id}';
        lines.push(
          `- ${id}: customer chose google_sheets → use https://sheets.googleapis.com/v4/spreadsheets/${sheetsId}/values with auth.type=OAuth2`,
        );
        break;
      }
      default: {
        lines.push(
          `- ${id}: customer chose ${choice} → implement using the appropriate Google API with auth.type=OAuth2`,
        );
      }
    }
  }

  return lines.join('\n');
}
