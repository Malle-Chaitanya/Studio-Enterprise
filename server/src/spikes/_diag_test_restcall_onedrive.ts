/** Minimal proof: can Application Integration itself call Microsoft Graph (via the
 *  authConfig we just created) and get the real rate sheet data back -- the core
 *  unproven piece of the connector-migration question.
 *  npx tsx src/spikes/_diag_test_restcall_onedrive.ts */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const gcpToken = await getSaToken();
const PROJECT = 'agentmigrations';
const LOCATION = 'us-east1';
const INTEGRATION = 'GetRateSheetBand_ConnectorProof';
const AUTH_CONFIG = 'ms-graph-onedrive';
const USER = 'erik@filefuze.co';
const FILE_ID = '01NMN5O4EYOSCQPAGDLRAZ2BN6U36UPI4M';
const SHEET = 'demo-rate-sheet-2026 (2)';

const graphUrl = `https://graph.microsoft.com/v1.0/users/${USER}/drive/items/${FILE_ID}/workbook/worksheets('${encodeURIComponent(SHEET)}')/usedRange`;

const integrationDefinition = {
  description: 'Proof: Application Integration calling real Microsoft Graph via authConfig.',
  triggerConfigs: [
    {
      label: 'API Trigger',
      startTasks: [{ taskId: '1' }],
      properties: { 'Trigger name': `${INTEGRATION}_API_1` },
      triggerType: 'API',
      triggerNumber: '1',
      triggerId: `api_trigger/${INTEGRATION}_API_1`,
      inputVariables: { names: [] },
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
        responseStatus: { key: 'responseStatus', value: { stringArray: { stringValues: ['$Task_1_responseStatus$'] } } },
        throwError: { key: 'throwError', value: { booleanValue: false } },
      },
      taskExecutionStrategy: 'WHEN_ALL_SUCCEED',
      displayName: 'Call Microsoft Graph',
      externalTaskType: 'NORMAL_TASK',
    },
  ],
  integrationParameters: [
    { key: 'RateSheetData', dataType: 'STRING_VALUE', defaultValue: { stringValue: '' }, displayName: 'RateSheetData', inputOutputType: 'OUT' },
  ],
};

const uploadUrl = `https://${LOCATION}-integrations.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/integrations/${INTEGRATION}/versions:upload`;
const uploadRes = await fetch(uploadUrl, {
  method: 'POST',
  headers: { Authorization: `Bearer ${gcpToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ content: JSON.stringify(integrationDefinition), fileFormat: 'JSON' }),
});
console.log('Upload status:', uploadRes.status);
const uploadJson = (await uploadRes.json()) as { integrationVersion?: { name?: string } };
if (!uploadJson.integrationVersion?.name) {
  console.log(JSON.stringify(uploadJson).slice(0, 1500));
  process.exit(0);
}
console.log('Created:', uploadJson.integrationVersion.name);

const versionId = uploadJson.integrationVersion.name.split('/').pop();
const base = `https://${LOCATION}-integrations.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/integrations/${INTEGRATION}`;
const publishRes = await fetch(`${base}/versions/${versionId}:publish`, { method: 'POST', headers: { Authorization: `Bearer ${gcpToken}`, 'Content-Type': 'application/json' }, body: '{}' });
console.log('Publish status:', publishRes.status);

const execRes = await fetch(
  `https://integrations.googleapis.com/v2/projects/${PROJECT}/locations/${LOCATION}/integrations/${INTEGRATION}:execute?triggerId=api_trigger/${INTEGRATION}_API_1`,
  { method: 'POST', headers: { Authorization: `Bearer ${gcpToken}`, 'Content-Type': 'application/json' }, body: '{}' },
);
console.log('\nExecute status:', execRes.status);
console.log((await execRes.text()).slice(0, 2000));
process.exit(0);
