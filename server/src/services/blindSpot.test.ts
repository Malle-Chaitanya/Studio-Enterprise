import { describe, it, expect } from 'vitest';
import { diffTools, summariseDiff, type LlmTool } from './blindSpot.js';
import type { AgentToolIR } from '../types.js';

/**
 * The diff is the part that must be deterministic, so it is the part that is tested.
 * The LLM call is exercised by `_diag_blind_spot.ts` against real payloads — mocking a
 * model's judgement would only test the mock.
 *
 * The case that matters most is `llmOnly`: that bucket is the §1.23 signal. A regression
 * that quietly matched an unmatched tool would make the whole exercise report "all clear"
 * on an agent with missing operations — the same silence that cost us 26 operations.
 */

const parserTool = (over: Partial<AgentToolIR>): AgentToolIR => ({
  name: 'Jira - Get list of issues',
  kind: 'connector' as AgentToolIR['kind'],
  ...over,
});

const llmTool = (over: Partial<LlmTool>): LlmTool => ({
  name: 'Jira - Get list of issues',
  confidence: 'high',
  ...over,
});

describe('matching', () => {
  it('matches on identical names', () => {
    const d = diffTools([parserTool({})], [llmTool({})]);
    expect(d.both).toHaveLength(1);
    expect(d.llmOnly).toHaveLength(0);
    expect(d.parserOnly).toHaveLength(0);
  });

  it('matches across punctuation and case drift', () => {
    const d = diffTools([parserTool({ name: 'Get_List Of Issues' })], [llmTool({ name: 'get list of issues' })]);
    expect(d.both).toHaveLength(1);
  });

  it('matches on displayName when the component name differs', () => {
    const d = diffTools(
      [parserTool({ name: 'topic_component_47', displayName: 'Search Confluence' })],
      [llmTool({ name: 'Search Confluence' })],
    );
    expect(d.both).toHaveLength(1);
  });

  it('matches on an exact operationId even when names disagree entirely', () => {
    const d = diffTools(
      [parserTool({ name: 'component-a', operationId: 'ListIssues' })],
      [llmTool({ name: 'totally different label', operationHint: 'ListIssues' })],
    );
    expect(d.both).toHaveLength(1);
  });

  it('matches a qualified parser name against a bare model name', () => {
    const d = diffTools(
      [parserTool({ name: 'Jira - Get list of issues' })],
      [llmTool({ name: 'Get list of issues' })],
    );
    expect(d.both).toHaveLength(1);
  });
});

describe('same component, different label', () => {
  // Observed live 2026-08-19: the parser names a tool after its component
  // ("Custom prompt 8/3/2026, 12:23:14 PM"), the model after the action
  // ("InvokeAIBuilderModelTaskAction"). Nothing else matches those, so the pair was
  // reported as a blind spot the parser had actually seen. False positives at that rate
  // train the reader to ignore the report.
  it('matches when foundIn names the parser tool exactly', () => {
    const d = diffTools(
      [parserTool({ name: 'Custom prompt 8/3/2026, 12:23:14 PM' })],
      [llmTool({ name: 'InvokeAIBuilderModelTaskAction', foundIn: 'Custom prompt 8/3/2026, 12:23:14 PM' })],
    );
    expect(d.both).toHaveLength(1);
    expect(d.llmOnly).toHaveLength(0);
  });

  it('matches foundIn against displayName too', () => {
    const d = diffTools(
      [parserTool({ name: 'component_12', displayName: 'Search Jira' })],
      [llmTool({ name: 'ListIssues', foundIn: 'Search Jira' })],
    );
    expect(d.both).toHaveLength(1);
  });

  it('still reports a blind spot when foundIn names a component the parser never produced', () => {
    // The §1.23 shape: the action is embedded in a TOPIC, and no parser tool corresponds
    // to that topic at all. foundIn must not accidentally absorb this.
    const d = diffTools(
      [parserTool({ name: 'Jira - Get list of issues' })],
      [llmTool({ name: 'PerformUnboundActionWithOrganization', foundIn: 'QMA.Incident topic' })],
    );
    expect(d.llmOnly).toHaveLength(1);
  });
});

describe('exact matches are claimed before fuzzy ones', () => {
  // Observed live 2026-08-19 on agent "Migrate Advisor". Confluence exposes BOTH GetPages
  // and GetPagesBySpace, authored as "Confluence - Get pages" and "Confluence - Get pages
  // within a space" — one name contains the other. Single-pass greedy matching let the
  // shorter model entry steal the longer parser tool, and the real pair was then reported
  // as a blind spot on an operation the parser had extracted correctly.
  it('does not let containment steal a partner an exact match had claim to', () => {
    const d = diffTools(
      [
        parserTool({ name: 'Confluence - Get pages', operationId: 'GetPages' }),
        parserTool({ name: 'Confluence - Get pages within a space', operationId: 'GetPagesBySpace' }),
      ],
      [
        llmTool({ name: 'Confluence - Get pages', operationHint: 'GetPages' }),
        llmTool({
          name: 'Get Pages Within a Space',
          operationHint: 'GetPagesBySpace',
          foundIn: 'Confluence - Get pages within a space',
        }),
      ],
    );
    expect(d.both).toHaveLength(2);
    expect(d.llmOnly).toHaveLength(0);
    expect(d.parserOnly).toHaveLength(0);
  });

  it('still falls back to containment when no exact evidence exists', () => {
    const d = diffTools(
      [parserTool({ name: 'Jira - Get list of issues' })],
      [llmTool({ name: 'Get list of issues' })],
    );
    expect(d.both).toHaveLength(1);
  });

  it('never matches one parser tool to two model entries', () => {
    const d = diffTools(
      [parserTool({ name: 'Get issue' })],
      [llmTool({ name: 'Get issue' }), llmTool({ name: 'Get issue' })],
    );
    expect(d.both).toHaveLength(1);
    expect(d.llmOnly).toHaveLength(1);
  });
});

describe('the blind-spot signal', () => {
  it('reports a tool only the model saw — the §1.23 shape', () => {
    // A connector action embedded inside a topic, which the TaskDialog parser never saw.
    const d = diffTools(
      [parserTool({ name: 'Jira - Get list of issues' })],
      [
        llmTool({ name: 'Jira - Get list of issues' }),
        llmTool({
          name: 'PerformUnboundActionWithOrganization',
          foundIn: 'QMA.Incident topic',
          confidence: 'high',
        }),
      ],
    );
    expect(d.both).toHaveLength(1);
    expect(d.llmOnly).toHaveLength(1);
    expect(d.llmOnly[0].name).toBe('PerformUnboundActionWithOrganization');
  });

  it('reports a tool only the parser saw as parserOnly, not as a blind spot', () => {
    const d = diffTools([parserTool({ name: 'HubSpot - List companies' })], []);
    expect(d.parserOnly).toHaveLength(1);
    expect(d.llmOnly).toHaveLength(0);
  });

  it('does not collapse two similar tools into one match', () => {
    // Both parser tools are plausible matches for the first model tool. Greedy one-to-one
    // must consume only one, leaving the second visible rather than silently absorbed.
    const d = diffTools(
      [parserTool({ name: 'Get issue' }), parserTool({ name: 'Get issue V2' })],
      [llmTool({ name: 'Get issue' })],
    );
    expect(d.both).toHaveLength(1);
    expect(d.parserOnly).toHaveLength(1);
  });

  it('handles an agent with no tools on either side', () => {
    const d = diffTools([], []);
    expect(d).toEqual({ both: [], parserOnly: [], llmOnly: [] });
  });

  it('ignores an empty model name rather than matching everything', () => {
    const d = diffTools([parserTool({ name: 'Anything' })], [llmTool({ name: '' })]);
    expect(d.both).toHaveLength(0);
    expect(d.parserOnly).toHaveLength(1);
  });
});

describe('summary', () => {
  it('says all clear when nothing is unmatched', () => {
    const d = diffTools([parserTool({})], [llmTool({})]);
    expect(summariseDiff(d)).toContain('no blind spots found');
  });

  it('names the suspect components so a human can go look', () => {
    const d = diffTools([], [llmTool({ name: 'Hidden Tool', foundIn: 'Topic X' })]);
    const s = summariseDiff(d);
    expect(s).toContain('Hidden Tool');
    expect(s).toContain('Topic X');
  });

  it('excludes low-confidence leads from the headline count', () => {
    // Low confidence still appears in llmOnly for anyone reading the detail, but promoting
    // model noise into the headline would train the reader to ignore the report.
    const d = diffTools([], [llmTool({ name: 'Maybe A Tool', confidence: 'low' })]);
    expect(summariseDiff(d)).toContain('no blind spots found');
    expect(d.llmOnly).toHaveLength(1);
  });
});
