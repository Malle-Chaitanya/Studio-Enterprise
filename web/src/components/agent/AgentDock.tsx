import { useState } from 'react';
import type { AgentDriverState } from '../../agent/driver.ts';

/**
 * The agent dock — one floating bar, pinned bottom-centre. This replaces the
 * resizable right-hand chat pane: the agent is not a panel beside the product,
 * it is the thing that operates the product.
 *
 * It shows exactly one of three faces, and never two at once:
 *   idle     → an input, plus suggestions that are real commands
 *   running  → what the agent is doing right now, and a way to stop it
 *   waiting  → amber, because the next move is the human's
 */
export function AgentDock({
  state,
  suggestions,
  onSubmit,
  onStop,
}: {
  state: AgentDriverState;
  suggestions: string[];
  onSubmit: (text: string) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState('');
  const [focus, setFocus] = useState(false);

  const running = state.mode === 'driving' || state.mode === 'thinking';
  const waiting = state.mode === 'waiting';

  const send = (value: string): void => {
    const v = value.trim();
    if (!v || running) return;
    setText('');
    onSubmit(v);
  };

  return (
    <div className={`v2-dock${focus ? ' focus' : ''}${waiting ? ' waiting' : ''}`}>
      {!running && !waiting && (
        <div className="v2-hints">
          {suggestions.map((s) => (
            <button key={s} type="button" className="v2-hint" onClick={() => send(s)}>
              {s}
            </button>
          ))}
        </div>
      )}

      <div className="v2-dockbar">
        {running ? (
          <>
            <span className="v2-spin" aria-hidden="true" />
            <span className="v2-runline">
              <span className="now">{state.caption || 'Working…'}</span>
              <span className="sub mono">
                {state.ledger.filter((l) => l.state !== 'live').length} steps done
              </span>
            </span>
            {/* Stop is always reachable while the agent holds the UI. */}
            <button type="button" className="v2-pause" onClick={onStop}>
              Stop
            </button>
          </>
        ) : (
          <>
            <span className="spark" aria-hidden="true">
              {waiting ? '◉' : '✦'}
            </span>
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onFocus={() => setFocus(true)}
              onBlur={() => setFocus(false)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') send(text);
              }}
              placeholder={
                waiting
                  ? 'Finish the highlighted step, then tell me to carry on'
                  : 'Tell the agent what to do…'
              }
              aria-label="Ask the agent"
            />
            <button
              type="button"
              className="go"
              onClick={() => send(text)}
              disabled={!text.trim()}
              aria-label="Send"
            >
              {'↑'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
