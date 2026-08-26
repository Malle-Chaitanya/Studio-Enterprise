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

describe('per-user tool credentials are reported, not silently shared', () => {
  it('flags every invoker tool and names them', async () => {
    const m = await mapAgent(base([
      { name: 'Office 365 Outlook - Send an email (V2)', displayName: 'SendEmail', kind: 'connector', connectionAuthMode: 'invoker' },
      { name: 'Get CRM objects from Hubspot - Get deals', displayName: 'GetDeals', kind: 'connector', connectionAuthMode: 'invoker' },
    ] as AgentIR['agentTools']));
    const n = note(m);
    expect(n?.status).toBe('needs-review');
    // Naming the tools is the difference between an actionable note and "something changed".
    expect(n?.detail).toContain('SendEmail');
    expect(n?.detail).toContain('GetDeals');
    // The consequence has to be stated in terms the customer can act on.
    expect(n?.detail).toMatch(/one mailbox|tenant-wide/);
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
