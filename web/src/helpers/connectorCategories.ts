/**
 * Connector grouping for the Connectors screen's icon grid — same pattern as CloudFuze
 * Manage's own `categorizedApps` (connect-ui/src/Components/helpers/utils.js): a flat
 * category key -> connector id list, plus a friendly label lookup. Frontend-only, by
 * design — this is a display concern, not a registry/backend one, matching how Manage
 * itself keeps it.
 *
 * Covers every connector id currently in server/src/connectors/registry.ts (195 as of
 * 2026-10-07). A connector added later and not yet listed here falls into OTHER rather
 * than disappearing from the grid.
 */

export const CONNECTOR_CATEGORIES: Record<string, string[]> = {
  MICROSOFT_365: [
    'shared_office365', 'shared_office365users', 'shared_office365groups', 'shared_office365groupsmail',
    'shared_outlook', 'shared_outlooktasks', 'shared_sharepointonline', 'shared_sharepointembedded',
    'shared_onedrive', 'shared_excel', 'shared_excelonline', 'shared_excelonlinebusiness',
    'shared_wordonlinebusiness', 'shared_onenote', 'shared_todo', 'shared_todoconsumer',
    'shared_microsoftbookings', 'shared_m365messagecenter', 'shared_microsoft365compliance',
    'shared_microsoftforms', 'shared_microsoftschooldatas', 'shared_planner', 'shared_projectonline',
    'shared_windows365',
  ],
  ENTRA_IDENTITY: ['shared_azuread', 'shared_azureadip'],
  TEAMS: ['shared_teams', 'shared_shifts'],
  DYNAMICS_365: [
    'shared_dynamicscrmonline', 'shared_commondataserviceforapps', 'shared_dynamicssmbsaas',
    'shared_dynamicssmbonprem', 'shared_dynamicsax', 'shared_dynamicsfraudprotect',
    'shared_dynamicstranslations', 'shared_dynamics365ratingsre', 'shared_dynamicsnavision',
  ],
  POWER_PLATFORM: [
    'shared_powerappsforadmins', 'shared_powerappsforappmakers', 'shared_powerappsnotification',
    'shared_powerappsnotificationv2', 'shared_powerplatformforadmins', 'shared_powerplatformadminv2',
    'shared_powervirtualagents', 'shared_powerbi', 'shared_flowmanagement', 'shared_microsoftflowforadmins',
    'shared_logicflows', 'shared_flowpush', 'shared_approvals', 'shared_advancedapprovals',
    'shared_uiflow', 'shared_dataflows',
  ],
  AZURE_INFRASTRUCTURE: [
    'shared_arm', 'shared_azureblob', 'shared_azurequeues', 'shared_azuretables', 'shared_servicebus',
    'shared_sql', 'shared_eventhubs', 'shared_keyvault', 'shared_azuremonitorlogs',
    'shared_azuremonitorlogsingestion', 'shared_azureloganalytics', 'shared_azureloganalyticsdatacollector',
    'shared_azureappservice', 'shared_azureautomation', 'shared_azuredatafactory', 'shared_azurevm',
    'shared_azureeventgrid', 'shared_azureeventgridpublish', 'shared_documentdb', 'shared_azuredigitaltwins',
    'shared_azuredatalake', 'shared_kusto', 'shared_azureiotcentral', 'shared_iotcentral', 'shared_aci',
    'shared_acl', 'shared_azuremysql', 'shared_azuremaps', 'shared_applicationinsights',
    'shared_visualstudioteamservices',
  ],
  AZURE_AI: [
    'shared_azureopenai', 'shared_cognitiveservicestextanalytics', 'shared_cognitiveservicescomputervision',
    'shared_cognitiveservicescontentmoderator', 'shared_cognitiveservicescustomvision', 'shared_formrecognizer',
    'shared_faceapi', 'shared_contentunderstanding', 'shared_azureaisearch', 'shared_azureaifoundryinference',
    'shared_azuretexttospeech', 'shared_azurespeechpronuncia', 'shared_cognitiveservicesspe',
    'shared_azurebatchspeechtotts', 'shared_qnamaker', 'shared_luis', 'shared_microsofttranslatorv2',
    'shared_videoindexerv2',
  ],
  SECURITY_COMPLIANCE: [
    'shared_defendersoc', 'shared_wdatp', 'shared_cloudappsecurity', 'shared_securitycopilot',
    'shared_graphsecurity', 'shared_riskiqintelligence', 'shared_virustotal',
  ],
  AZURE_COMMUNICATION: [
    'shared_azurecommunicationservicessms', 'shared_acssmsevents', 'shared_acschat', 'shared_acsemail',
    'shared_acsidentity',
  ],
  MICROSOFT_PARTNER_MISC: [
    'shared_partnercenterevents', 'shared_partnercenterref', 'shared_microsoftpartnercent',
    'shared_bingsearch', 'shared_fhirbase', 'shared_fhirclinical',
  ],
  ONPREM_PROTOCOLS: [
    'shared_filesystem', 'shared_biztalkserver', 'shared_smtp', 'shared_rss', 'shared_mq',
    'shared_as2', 'shared_edifact', 'shared_x12', 'shared_sapodata', 'shared_http',
  ],
  GOOGLE_WORKSPACE: [
    'shared_googledrive', 'shared_gmail', 'shared_googlecalendar', 'shared_googlecontacts', 'shared_googlechat',
  ],
  CRM_SALES: [
    'shared_hubspot', 'shared_hubspotcrmv2', 'shared_hubspotcrm', 'shared_hubspotcms', 'shared_hubspotsettingsv2',
    'shared_salesforce', 'shared_pipedrive', 'shared_freshsales', 'shared_insightly', 'shared_capsulecrm',
    'shared_chatter', 'shared_linkedin', 'shared_linkedinv2',
  ],
  SUPPORT_ITSM: [
    'shared_service-now', 'shared_freshdesk', 'shared_zendesk', 'shared_freshservice', 'shared_intercom',
    'shared_pagerduty',
  ],
  PROJECT_WORK_MANAGEMENT: [
    'shared_jira', 'shared_confluence', 'shared_asana', 'shared_trello', 'shared_monday', 'shared_smartsheet',
    'shared_teamwork', 'shared_basecamp', 'shared_basecamp2', 'shared_pivotaltracker', 'shared_toodledo',
    'shared_todoist',
  ],
  COLLABORATION_CHAT: ['shared_slack', 'shared_campfire'],
  FILE_STORAGE: ['shared_dropbox', 'shared_box'],
  MARKETING_EMAIL: [
    'shared_mailchimp', 'shared_sendgrid', 'shared_sparkpost', 'shared_infusionsoft', 'shared_buffer',
    'shared_gotowebinar', 'shared_gototraining', 'shared_eventbrite', 'shared_inoreader',
  ],
  DEV_TOOLS: ['shared_github', 'shared_gitlab', 'shared_bitbucket'],
  COMMERCE_PAYMENTS: ['shared_stripe', 'shared_bigcommerce', 'shared_adobecommerce', 'shared_docusign', 'shared_hellosign'],
  SOCIAL_MEDIA: ['shared_pinterest', 'shared_twitter', 'shared_vimeo', 'shared_bitly'],
  CONTENT_FORMS: ['shared_notion', 'shared_airtable', 'shared_typeform', 'shared_surveymonkey'],
  OTHER: ['shared_twilio'],
};

const CATEGORY_LABELS: Record<string, string> = {
  // Matches the shared credential card's own name ("Microsoft Office 365 (one App
  // Registration)") — not currently rendered anywhere (the section headers were removed when
  // fixing the redundant-heading issue), kept consistent for whenever this label IS surfaced.
  MICROSOFT_365: 'Microsoft Office 365',
  ENTRA_IDENTITY: 'Entra / Identity',
  TEAMS: 'Teams',
  DYNAMICS_365: 'Dynamics 365',
  POWER_PLATFORM: 'Power Platform',
  AZURE_INFRASTRUCTURE: 'Azure Infrastructure',
  AZURE_AI: 'Azure AI / Cognitive Services',
  SECURITY_COMPLIANCE: 'Security & Compliance',
  AZURE_COMMUNICATION: 'Azure Communication Services',
  MICROSOFT_PARTNER_MISC: 'Microsoft (Other)',
  ONPREM_PROTOCOLS: 'On-Premises & Protocols',
  GOOGLE_WORKSPACE: 'Google Workspace',
  CRM_SALES: 'CRM & Sales',
  SUPPORT_ITSM: 'Support & ITSM',
  PROJECT_WORK_MANAGEMENT: 'Project & Work Management',
  COLLABORATION_CHAT: 'Collaboration & Chat',
  FILE_STORAGE: 'File Storage',
  MARKETING_EMAIL: 'Marketing & Email',
  DEV_TOOLS: 'Developer Tools',
  COMMERCE_PAYMENTS: 'Commerce & Payments',
  SOCIAL_MEDIA: 'Social Media',
  CONTENT_FORMS: 'Content & Forms',
  OTHER: 'Other',
};

/** Display order — Microsoft families first (what this product is really about),
 *  then the rest roughly by how often they show up. */
export const CATEGORY_ORDER = [
  'MICROSOFT_365', 'ENTRA_IDENTITY', 'TEAMS', 'DYNAMICS_365', 'POWER_PLATFORM',
  'AZURE_INFRASTRUCTURE', 'AZURE_AI', 'AZURE_COMMUNICATION', 'SECURITY_COMPLIANCE',
  'MICROSOFT_PARTNER_MISC', 'ONPREM_PROTOCOLS', 'GOOGLE_WORKSPACE', 'CRM_SALES',
  'SUPPORT_ITSM', 'PROJECT_WORK_MANAGEMENT', 'COLLABORATION_CHAT', 'FILE_STORAGE',
  'MARKETING_EMAIL', 'DEV_TOOLS', 'COMMERCE_PAYMENTS', 'SOCIAL_MEDIA', 'CONTENT_FORMS', 'OTHER',
];

/**
 * The categories that are genuinely Microsoft's own connectors — first-party products and
 * the generic on-premises/protocol connectors Microsoft itself ships through Power Platform.
 * Only these get their own labeled section; every other category (HubSpot, Salesforce,
 * Jira, Slack, Google Workspace, ...) collapses into one flat "Other connectors" group, same
 * as before this feature existed.
 */
const MICROSOFT_CATEGORIES = new Set([
  'MICROSOFT_365', 'ENTRA_IDENTITY', 'TEAMS', 'DYNAMICS_365', 'POWER_PLATFORM',
  'AZURE_INFRASTRUCTURE', 'AZURE_AI', 'AZURE_COMMUNICATION', 'SECURITY_COMPLIANCE',
  'MICROSOFT_PARTNER_MISC', 'ONPREM_PROTOCOLS',
]);

export function isMicrosoftCategory(key: string): boolean {
  return MICROSOFT_CATEGORIES.has(key);
}

const CONNECTOR_TO_CATEGORY: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const [cat, ids] of Object.entries(CONNECTOR_CATEGORIES)) {
    for (const id of ids) map[id] = cat;
  }
  return map;
})();

export function categoryForConnector(connectorId: string): string {
  return CONNECTOR_TO_CATEGORY[connectorId] ?? 'OTHER';
}

export function categoryLabel(key: string): string {
  return CATEGORY_LABELS[key] ?? key;
}
