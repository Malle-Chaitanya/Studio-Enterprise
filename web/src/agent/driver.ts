/**
 * The agent driver.
 *
 * ONE RULE, and it is the whole reason this file exists: the cursor, the caption
 * and the blue edges are moved by events that describe work that ALREADY
 * happened (or is happening) — never by a script that guesses what the agent is
 * about to do. If no event has arrived, the driver sits in `thinking` and the
 * cursor does not move. A migration tool that animates steps nobody performed is
 * lying to a customer about their data, which is the one failure this product
 * cannot afford.
 *
 * Events come from two real sources today:
 *   1. the chat agent's tool calls (WizardContext.lastToolEvent), and
 *   2. the page's own async lifecycle — a fetch that resolved, a Secret Manager
 *      write that returned, a validation verdict that came back.
 * Both are facts. Neither is a timeline.
 */

/** Where the agent is pointing. Resolved to a DOM node via `[data-agent-target]`. */
export type AgentTarget = string;

export type AgentEvent =
  /** Work is in flight but has no on-screen target yet (a fetch, a decision). */
  | { kind: 'thinking'; note: string }
  /** The agent has begun a step against a specific element. */
  | { kind: 'tool_start'; tool: string; note: string; target?: AgentTarget }
  /** The step finished. `ok:false` records a real failure — it is still a fact. */
  | { kind: 'tool_end'; tool: string; note: string; target?: AgentTarget; ok: boolean }
  /** The agent has stopped because only a human may do the next part. */
  | { kind: 'awaiting_human'; note: string; target?: AgentTarget }
  /** Nothing left to do. */
  | { kind: 'done'; note: string }
  /** Leave takeover entirely (user pressed stop, or navigated away). */
  | { kind: 'idle' };

export type AgentMode = 'idle' | 'thinking' | 'driving' | 'waiting' | 'done';

/** One line the agent has earned the right to display. */
export interface LedgerLine {
  text: string;
  state: 'ok' | 'live' | 'stop' | 'fail';
}

export interface AgentDriverState {
  mode: AgentMode;
  /** Caption text shown beside the cursor. Empty when there is nothing honest to say. */
  caption: string;
  /** `data-agent-target` value of the element the agent is touching, or null. */
  target: AgentTarget | null;
  /** Bumped on every tool_end so the cursor can play its tap ripple exactly once. */
  clickEpoch: number;
  ledger: LedgerLine[];
}

export const initialAgentState: AgentDriverState = {
  mode: 'idle',
  caption: '',
  target: null,
  clickEpoch: 0,
  ledger: [],
};

/**
 * Fold one event into the driver state.
 *
 * Deliberately total and side-effect free so it can be unit-tested: given a list
 * of events, the ledger it produces must contain nothing that was not in them.
 */
export function reduceAgent(state: AgentDriverState, ev: AgentEvent): AgentDriverState {
  switch (ev.kind) {
    case 'idle':
      return { ...initialAgentState };

    case 'thinking':
      return {
        ...state,
        mode: 'thinking',
        caption: ev.note,
        // Keep the last target: the cursor stays where it genuinely is rather
        // than snapping to a corner between two real steps.
        ledger: withLine(state.ledger, { text: ev.note, state: 'live' }),
      };

    case 'tool_start':
      return {
        ...state,
        mode: 'driving',
        caption: ev.note,
        target: ev.target ?? state.target,
        ledger: withLine(state.ledger, { text: ev.note, state: 'live' }),
      };

    case 'tool_end':
      return {
        ...state,
        mode: 'driving',
        caption: ev.note,
        target: ev.target ?? state.target,
        clickEpoch: state.clickEpoch + 1,
        ledger: withLine(state.ledger, { text: ev.note, state: ev.ok ? 'ok' : 'fail' }),
      };

    case 'awaiting_human':
      return {
        ...state,
        mode: 'waiting',
        caption: ev.note,
        target: ev.target ?? state.target,
        ledger: withLine(state.ledger, { text: ev.note, state: 'stop' }),
      };

    case 'done':
      return {
        ...state,
        mode: 'done',
        caption: ev.note,
        target: null,
        ledger: withLine(state.ledger, { text: ev.note, state: 'ok' }),
      };
  }
}

/**
 * Append a line, dropping any previous in-flight one.
 *
 * Only ONE line may be live at a time: the agent does one thing at a time, and a
 * ledger with two live lines would imply work running in parallel that is not.
 */
function withLine(ledger: LedgerLine[], line: LedgerLine): LedgerLine[] {
  return [...ledger.filter((l) => l.state !== 'live'), line];
}
