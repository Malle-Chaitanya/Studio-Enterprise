import { useEffect, useState } from 'react';
import type { AgentDriverState } from '../../agent/driver.ts';

/** Where the cursor is drawn. null until a real event names a target we can find. */
interface Spot { x: number; y: number }

/**
 * The takeover chrome: blurred blue edges, a rim, a state tag, the agent cursor
 * and its caption.
 *
 * The cursor position is derived ONLY from `state.target`, which only changes
 * when an event arrives (see agent/driver.ts). If the named element is not on
 * screen the cursor simply does not appear — it never travels to a guess.
 * The centre of the viewport stays unblurred on purpose: the customer has to be
 * able to read the rows being changed, or watching the agent is theatre.
 */
export function DrivingLayer({ state }: { state: AgentDriverState }) {
  const [spot, setSpot] = useState<Spot | null>(null);
  const [found, setFound] = useState(false);

  const active = state.mode !== 'idle';
  const waiting = state.mode === 'waiting';

  // Resolve the target to a live rect. Re-run on scroll/resize so the cursor
  // stays glued to its row instead of drifting off it.
  useEffect(() => {
    if (!state.target) { setFound(false); return; }
    const place = (): void => {
      const el = document.querySelector<HTMLElement>(`[data-agent-target="${state.target}"]`);
      if (!el) { setFound(false); return; }
      const r = el.getBoundingClientRect();
      setSpot({ x: r.left + Math.min(r.width * 0.5, 240), y: r.top + r.height / 2 });
      setFound(true);
    };
    place();
    // A target can be named a frame before its element exists (the credential
    // dialog mounts after the event that points into it). Retry briefly, then
    // give up quietly — a cursor pointing at nothing is worse than no cursor.
    let tries = 0;
    const retry = window.setInterval(() => {
      if (++tries > 30) { window.clearInterval(retry); return; }
      place();
    }, 50);
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.clearInterval(retry);
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [state.target, state.clickEpoch]);

  // Mark the element the agent is on so it can highlight itself, and scroll it
  // into view — an off-screen action the user cannot see reads as nothing happening.
  useEffect(() => {
    if (!state.target || !active) return;
    const el = document.querySelector<HTMLElement>(`[data-agent-target="${state.target}"]`);
    if (!el) return;
    el.classList.add('acting');
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return () => el.classList.remove('acting');
  }, [state.target, active]);

  const showCursor = active && found && spot !== null;
  const tag = waiting ? 'Your turn' : state.mode === 'thinking' ? 'Working' : 'Agent driving';

  return (
    <>
      <div className={`v2-edges${active ? ' on' : ''}`} aria-hidden="true" />
      <div className={`v2-rim${active ? ' on' : ''}${waiting ? ' you' : ''}`} aria-hidden="true" />
      <div className={`v2-tag${active ? ' on' : ''}${waiting ? ' you' : ''}`}>
        <span>{tag}</span>
      </div>

      {/* The caption is the agent's voice. It is announced, because a blind user
          gets no information at all from a moving arrow. */}
      <div
        className={`v2-caption${active && state.caption ? ' on' : ''}${waiting ? ' you' : ''}`}
        role="status"
        aria-live="polite"
        style={
          showCursor
            ? { left: Math.min(spot.x + 26, window.innerWidth - 460), top: spot.y + 16 }
            : { left: '50%', bottom: 100, transform: 'translateX(-50%)' }
        }
      >
        {state.mode === 'thinking' && <span className="v2-spin-d" aria-hidden="true" />}
        <span>{state.caption}</span>
      </div>

      {showCursor && (
        <div
          /* Remounting on clickEpoch replays the tap ripple exactly once per
             completed step — one ripple, one real action. */
          className="v2-cursor on click"
          key={state.clickEpoch}
          style={{ left: spot.x, top: spot.y }}
          aria-hidden="true"
        >
          <span className="ring" />
          <svg viewBox="0 0 24 24" fill="none">
            <path
              d="M5 3l14 8.5-6.2 1.4L9.6 20 5 3z"
              fill={waiting ? '#e08700' : '#0129ac'}
              stroke="#fff"
              strokeWidth="1.4"
            />
          </svg>
        </div>
      )}
    </>
  );
}
