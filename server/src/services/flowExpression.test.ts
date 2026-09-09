import { describe, it, expect } from 'vitest';
import { parseTemplate, parseFlowExpr, unwrapAccessors, isCallTo } from './flowExpression.js';

// Every string here is a REAL expression pulled from a live Copilot Studio Agent Flow
// this session (Deal Desk's GetRateSheetBand / DraftFollowUpEmail / Postoteams) — not
// invented shapes. See services/flowMapper.ts's header for why a real parser exists.

describe('parseTemplate', () => {
  it('splits a multi-reference Compose template into literal/expr parts in order', () => {
    const parts = parseTemplate(
      "New limit approved. Rate updated. Covenant status unchanged. Details:\n\n@{triggerBody()?['text']}  \n@{triggerBody()?['text_1']} \n\n",
    );
    expect(parts[0]).toEqual({ kind: 'literal', text: 'New limit approved. Rate updated. Covenant status unchanged. Details:\n\n' });
    expect(parts[1].kind).toBe('expr');
    expect(parts[2]).toEqual({ kind: 'literal', text: '  \n' });
    expect(parts[3].kind).toBe('expr');
    expect(parts[4]).toEqual({ kind: 'literal', text: ' \n\n' });
  });

  it('treats a whole-value `@{...}` reference as a single expr part with no literal', () => {
    const parts = parseTemplate("@{outputs('Compose')}");
    expect(parts).toHaveLength(1);
    expect(parts[0].kind).toBe('expr');
  });

  it('treats a bare `@expr` (no braces) as one expr part — the Query from/where convention', () => {
    const parts = parseTemplate("@outputs('List_rows_present_in_a_table')?['body/value']");
    expect(parts).toHaveLength(1);
    expect(parts[0].kind).toBe('expr');
  });

  it('does not mistake an apostrophe in literal HTML text for a WDL string delimiter', () => {
    const parts = parseTemplate(
      '<p>Here\'s the amendment summary:</p>@{triggerBody()?[\'text\']}</p>',
    );
    expect(parts[0]).toEqual({ kind: 'literal', text: "<p>Here's the amendment summary:</p>" });
    expect(parts[1].kind).toBe('expr');
    expect(parts[2]).toEqual({ kind: 'literal', text: '</p>' });
  });

  it('unescapes @@ to a literal @ outside any expression', () => {
    const parts = parseTemplate('reach us @@support');
    expect(parts).toEqual([{ kind: 'literal', text: 'reach us @support' }]);
  });
});

describe('parseFlowExpr — real nested boolean/comparison grammar (GetRateSheetBand Query.where)', () => {
  it('parses and(lessOrEquals(int(item()[...]), triggerBody()[...]), greater(...)) fully', () => {
    const e = parseFlowExpr(
      "and(lessOrEquals(int(item()['Limit Band Min']), triggerBody()['number']), greater(int(item()['Limit Band Max']), triggerBody()['number']))",
    );
    expect(e.kind).toBe('call');
    if (e.kind !== 'call') throw new Error('unreachable');
    expect(e.name).toBe('and');
    expect(e.args).toHaveLength(2);
    const [left, right] = e.args;
    expect(left.kind).toBe('call');
    if (left.kind !== 'call') throw new Error('unreachable');
    expect(left.name).toBe('lessOrEquals');
    // int(item()['Limit Band Min'])
    const intCall = left.args[0];
    expect(intCall.kind).toBe('call');
    if (intCall.kind !== 'call') throw new Error('unreachable');
    expect(intCall.name).toBe('int');
    const itemAccessor = unwrapAccessors(intCall.args[0]);
    expect(itemAccessor?.keys).toEqual(['Limit Band Min']);
    expect(isCallTo(itemAccessor!.root, 'item')).toBe(true);
    // right side of lessOrEquals: triggerBody()['number'] — unsafe accessor
    const triggerAccessor = unwrapAccessors(left.args[1]);
    expect(triggerAccessor?.keys).toEqual(['number']);
    expect(isCallTo(triggerAccessor!.root, 'triggerBody')).toBe(true);
    expect(right.kind).toBe('call');
    if (right.kind !== 'call') throw new Error('unreachable');
    expect(right.name).toBe('greater');
  });
});

describe('unwrapAccessors', () => {
  it('collects safe (?[...]) and unsafe ([...]) keys outermost-last, in access order', () => {
    const e = parseFlowExpr("outputs('Post_message_in_a_chat_or_channel')?['body/messageLink']");
    const u = unwrapAccessors(e);
    expect(u?.keys).toEqual(['body/messageLink']);
    expect(u && isCallTo(u.root, 'outputs')).toBe(true);
    expect(u?.root.args[0]).toEqual({ kind: 'string', value: 'Post_message_in_a_chat_or_channel' });
  });

  it('returns undefined when the base is not ultimately a call', () => {
    const u = unwrapAccessors({ kind: 'string', value: 'literal, not a call' });
    expect(u).toBeUndefined();
  });
});
