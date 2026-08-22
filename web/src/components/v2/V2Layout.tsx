import type { ReactNode } from 'react';
// Imported by the shell, not by each screen: every v2 phase renders inside this,
// so the stylesheet arrives exactly once no matter how many screens exist.
import '../../design/v2.css';
import { AgentDock } from '../agent/AgentDock.tsx';
import { DrivingLayer } from '../agent/DrivingLayer.tsx';
import type { AgentDriverState } from '../../agent/driver.ts';
import { useSource } from '../../v2/data/index.ts';
import { PhaseRail, type PhaseId, type PhaseStatus } from './PhaseRail.tsx';

/**
 * The v2 shell: rail, work area, inspector, agent dock and takeover chrome.
 *
 * Every phase screen renders inside this, so the frame is identical across all
 * eight and a change to it lands everywhere at once. Screens supply their canvas
 * and their inspector; nothing else.
 */
export function V2Layout({
  phase,
  phaseStatus,
  agent,
  suggestions,
  onPrompt,
  onStop,
  manual,
  canvas,
  inspector,
  toast,
}: {
  phase: PhaseId;
  phaseStatus?: Partial<Record<PhaseId, PhaseStatus>>;
  agent: AgentDriverState;
  suggestions: string[];
  onPrompt: (text: string) => void;
  onStop: () => void;
  /** Manual mode hides the dock: the agent is optional, never mandatory. */
  manual?: boolean;
  canvas: ReactNode;
  inspector: ReactNode;
  toast?: string;
}) {
  const source = useSource();
  const waiting = agent.mode === 'waiting';

  return (
    <div className={`v2${waiting ? ' waiting' : ''}`}>
      <div className="v2-frame">
        <PhaseRail current={phase} status={phaseStatus} />
        <div className="v2-work">
          <div className="v2-canvas">{canvas}</div>
          {inspector}
        </div>
      </div>

      {/* Canned data must be impossible to mistake for a real migration, so the
          banner comes from the source itself rather than from a route or a flag. */}
      {source.isFixture && <div className="v2-fixture">Fixture data — not a real migration</div>}

      <div className={`v2-toast${toast ? ' on' : ''}`} role="status" aria-live="polite">
        <span className="m" aria-hidden="true">✓</span>
        <span>{toast}</span>
      </div>

      <DrivingLayer state={agent} />
      {!manual && (
        <AgentDock state={agent} suggestions={suggestions} onSubmit={onPrompt} onStop={onStop} />
      )}
    </div>
  );
}
