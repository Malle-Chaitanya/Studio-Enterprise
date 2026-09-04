/** Build the REAL, complete GetRateSheetBand: real trigger input (NewLimit), the
 *  proven real Microsoft Graph connector call, and real filtering logic matching the
 *  source's exact expression (Limit Band Min <= NewLimit < Limit Band Max).
 *  npx tsx src/spikes/_diag_build_real_getratesheetband.ts */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const gcpToken = await getSaToken();
const PROJECT = 'agentmigrations';
const LOCATION = 'us-east1';
const INTEGRATION = 'GetRateSheetBand_AutoGen_v4';
const AUTH_CONFIG = 'ms-graph-onedrive';
const USER = 'erik@filefuze.co';
const FILE_ID = '01NMN5O4EYOSCQPAGDLRAZ2BN6U36UPI4M';
const SHEET = 'demo-rate-sheet-2026 (2)';
const graphUrl = `https://graph.microsoft.com/v1.0/users/${USER}/drive/items/${FILE_ID}/workbook/worksheets('${encodeURIComponent(SHEET)}')/usedRange`;

// Mirrors the SOURCE's exact filter: lessOrEquals(Limit Band Min, NewLimit) AND greater(Limit Band Max, NewLimit)
const filterScript = `function executeScript(event) {
  var rawLimit = String(event.getParameter("NewLimit"));
  var newLimit = Number(rawLimit.replace(/[,\\$\\s]/g, ""));
  var raw = event.getParameter("RateSheetData");
  var parsed = JSON.parse(raw);
  var rows = parsed.text || [];
  var matches = [];
  for (var i = 1; i < rows.length; i++) {
    var row = rows[i];
    var min = Number(row[1]);
    var max = Number(row[2]);
    if (min <= newLimit && max > newLimit) {
      matches.push(row[0] + ": " + row[3] + " (" + row[4] + ")");
    }
  }
  event.setParameter("MatchingRows", matches.join("; "));
}`;

const integrationDefinition = {
  description: 'Looks up every applicable interest rate and required approval tier for a given credit limit amount, across all risk ratings, from the bank\'s rate sheet. Auto-migrated from Copilot Studio flow "GetRateSheetBand".',
  triggerConfigs: [
    {
      label: 'API Trigger',
      startTasks: [{ taskId: '1' }],
      properties: { 'Trigger name': `${INTEGRATION}_API_1` },
      triggerType: 'API',
      triggerNumber: '1',
      triggerId: `api_trigger/${INTEGRATION}_API_1`,
      inputVariables: { names: ['NewLimit'] },
      outputVariables: {},
    },
  ],
  taskConfigs: [
    {
      task: 'GenericRestV2Task',
      taskId: '1',
      parameters: {
        httpMethod: { key: 'httpMethod', value: { stringValue: 'GET' } },
        url: { key: 'url', value: { stringValue: graphUrl } },
        authConfigName: { key: 'authConfigName', value: { stringValue: AUTH_CONFIG } },
        responseBody: { key: 'responseBody', value: { stringArray: { stringValues: ['$RateSheetData$'] } } },
        throwError: { key: 'throwError', value: { booleanValue: false } },
      },
      taskExecutionStrategy: 'WHEN_ALL_SUCCEED',
      displayName: 'Call Microsoft Graph (List rows)',
      externalTaskType: 'NORMAL_TASK',
      nextTasks: [{ taskId: '2' }],
    },
    {
      task: 'JavaScriptTask',
      taskId: '2',
      parameters: {
        script: { key: 'script', value: { stringValue: filterScript } },
        NewLimit: { key: 'NewLimit', value: { stringValue: '$NewLimit$' } },
        RateSheetData: { key: 'RateSheetData', value: { stringValue: '$RateSheetData$' } },
      },
      taskExecutionStrategy: 'WHEN_ALL_SUCCEED',
      displayName: 'Filter by limit band',
      externalTaskType: 'NORMAL_TASK',
    },
  ],
  integrationParameters: [
    { key: 'NewLimit', dataType: 'INT_VALUE', defaultValue: { intValue: '0' }, displayName: 'NewLimit', inputOutputType: 'IN' },
    { key: 'RateSheetData', dataType: 'STRING_VALUE', defaultValue: { stringValue: '' }, displayName: 'RateSheetData' },
    { key: 'MatchingRows', dataType: 'STRING_VALUE', defaultValue: { stringValue: '' }, displayName: 'MatchingRows', inputOutputType: 'OUT' },
  ],
};

const uploadUrl = `https://${LOCATION}-integrations.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/integrations/${INTEGRATION}/versions:upload`;
const uploadRes = await fetch(uploadUrl, {
  method: 'POST',
  headers: { Authorization: `Bearer ${gcpToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ content: JSON.stringify(integrationDefinition), fileFormat: 'JSON' }),
});
console.log('Upload status:', uploadRes.status);
const uploadJson = (await uploadRes.json()) as { integrationVersion?: { name?: string }; error?: unknown };
if (!uploadJson.integrationVersion?.name) {
  console.log(JSON.stringify(uploadJson).slice(0, 1500));
  process.exit(0);
}
console.log('Created:', uploadJson.integrationVersion.name);
const versionId = uploadJson.integrationVersion.name.split('/').pop();
const base = `https://${LOCATION}-integrations.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/integrations/${INTEGRATION}`;
const publishRes = await fetch(`${base}/versions/${versionId}:publish`, { method: 'POST', headers: { Authorization: `Bearer ${gcpToken}`, 'Content-Type': 'application/json' }, body: '{}' });
console.log('Publish status:', publishRes.status);
if (publishRes.status !== 200) console.log(await publishRes.text());

const execRes = await fetch(
  `https://integrations.googleapis.com/v2/projects/${PROJECT}/locations/${LOCATION}/integrations/${INTEGRATION}:execute?triggerId=api_trigger/${INTEGRATION}_API_1`,
  { method: 'POST', headers: { Authorization: `Bearer ${gcpToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ NewLimit: '2500000' }) },
);
console.log('\nExecute status (NewLimit=2500000):', execRes.status);
console.log((await execRes.text()).slice(0, 2000));
process.exit(0);
