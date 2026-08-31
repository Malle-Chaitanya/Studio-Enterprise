import { describe, it, expect, vi } from 'vitest';
import type { AgentIR } from '../types.js';

/**
 * Whose credentials a migrated tool runs under.
 *
 * Copilot's `invoker` mode is per-END-USER: the tool used the caller's own connection. Every
 * tool we deploy uses ONE stored credential, so that property is lost on migration — and lost
 * invisibly, because the tool still works. It just acts as the wrong person.
 *
 * `connectionAuthMode` was extracted and then read by nothing, so the report claimed a clean
 * migration over a real access change. These tests exist to keep that from going quiet again.
 */

// The LLM refinement step must not reach the network in a unit test.
vi.mock('./instructionLlm.js', () => ({ refineWithLlm: async (t: string) => t }));

const { mapAgent } = await import('./mapper.js');

const base = (tools: AgentIR['agentTools']): AgentIR => ({
  sourceId: 'a1',
  name: 'Sales desk',
  instructions: 'Do the thing.',
  description: 'd',
  capabilities: { webBrowsing: false, codeInterpreter: false },
  starterPrompts: [],
  topics: [],
  knowledgeSources: [],
  unmapped: [],
  agentTools: tools,
} as unknown as AgentIR);

const note = (m: Awaited<ReturnType<typeof mapAgent>>) =>
  m.fidelityNotes.find((n) => n.component === 'toolCredentials');

const notes = (m: Awaited<ReturnType<typeof mapAgent>>) =>
  m.fidelityNotes.filter((n) => n.component === 'toolCredentials');

describe('per-user tool credentials are reported, not silently shared', () => {
  it('tells the user there is NOTHING to do when the connector impersonates', async () => {
    const m = await mapAgent(base([
      { name: 'Office 365 Outlook - Send an email (V2)', displayName: 'SendEmail', kind: 'connector', connectorId: 'shared_office365', connectionAuthMode: 'invoker' },
    ] as AgentIR['agentTools']));
    const n = notes(m).find((x) => x.status === 'mapped');
    // Naming the tools is the difference between an actionable note and "something changed".
    expect(n?.detail).toContain('SendEmail');
    // Reproduced, not merely reported: no setup step, and nothing that expires later.
    expect(n?.detail).toMatch(/Nobody has to connect an account/);
    expect(n?.detail).toMatch(/nothing expires/);
  });

  it("reports a connector with no per-user sign-in as LOST, not as review", async () => {
    const m = await mapAgent(base([
      { name: 'Get CRM objects from Hubspot - Get companies', displayName: 'GetClientProfile', kind: 'connector', connectorId: 'shared_get-20crm-20objects-20from-20hubspot', connectionAuthMode: 'invoker' },
    ] as AgentIR['agentTools']));
    const n = notes(m).find((x) => x.component === 'toolCredentials');
    // 'lost' and 'needs-review' are different promises. This one has no remedy at all, and
    // filing it as reviewable would imply a setup step that does not exist.
    expect(n?.status).toBe('lost');
    expect(n?.detail).toContain('GetClientProfile');
    expect(n?.detail).toMatch(/no per-user sign-in/);
  });

  it('separates reproduced from lost when one agent has both', async () => {
    const m = await mapAgent(base([
      { name: 'Office 365 Outlook - Send an email (V2)', displayName: 'SendEmail', kind: 'connector', connectorId: 'shared_office365', connectionAuthMode: 'invoker' },
      { name: 'Get CRM objects from Hubspot - Get companies', displayName: 'GetClientProfile', kind: 'connector', connectorId: 'shared_get-20crm-20objects-20from-20hubspot', connectionAuthMode: 'invoker' },
    ] as AgentIR['agentTools']));
    const found = notes(m).filter((x) => x.component === 'toolCredentials');
    expect(found).toHaveLength(2);
    // Each tool appears under the verdict that is true FOR IT. Merging them would make the
    // fixable one look permanent, or the permanent one look like a pending setup step.
    expect(found.find((x) => x.status === 'mapped')?.detail).toContain('SendEmail');
    expect(found.find((x) => x.status === 'mapped')?.detail).not.toContain('GetClientProfile');
    expect(found.find((x) => x.status === 'lost')?.detail).toContain('GetClientProfile');
    expect(found.find((x) => x.status === 'lost')?.detail).not.toContain('SendEmail');
  });

  it('says nothing when every tool was already a shared maker connection', async () => {
    const m = await mapAgent(base([
      { name: 'Microsoft Dataverse - List rows', displayName: 'ListRows', kind: 'connector', connectionAuthMode: 'maker' },
    ] as AgentIR['agentTools']));
    // A note on an agent that lost nothing is noise, and noise is how real notes get skipped.
    expect(note(m)).toBeUndefined();
  });

  it('stays silent when the payload never said which mode a tool used', async () => {
    const m = await mapAgent(base([
      { name: 'Some tool', displayName: 'T', kind: 'connector' },
    ] as AgentIR['agentTools']));
    // `undefined` means the source did not tell us. Claiming per-user access was lost would
    // be inventing a finding out of missing data.
    expect(note(m)).toBeUndefined();
  });
});
