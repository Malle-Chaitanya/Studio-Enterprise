import { translateFlow, integrationNameForFlow } from '../services/flowMapper.js';
import type { FlowIR } from '../types.js';

const flow: FlowIR = {
  id: 'flow-3',
  name: 'DateFormatFlow',
  trigger: { type: 'Request', kind: 'Skills', inputSchema: [] },
  actions: [
    { id: 'Compose', type: 'Compose', runAfter: {}, raw: {}, compose: { template: "@{formatDateTime(utcNow(), 'MM/dd/yyyy')}" } },
  ],
  connectionReferences: [],
  unmapped: [],
} as any;
const result = translateFlow(flow, { integrationName: integrationNameForFlow(flow.name) });
console.log('fidelityNotes:', JSON.stringify(result.fidelityNotes, null, 2));
console.log('taskConfigs:', JSON.stringify((result.integrationDefinition as any).taskConfigs, null, 2));
console.log('startTasks:', JSON.stringify((result.integrationDefinition as any).triggerConfigs[0].startTasks));
