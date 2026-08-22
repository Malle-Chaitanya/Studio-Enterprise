import { useNavigate, useSearchParams } from 'react-router-dom';

/**
 * The phase rail.
 *
 * This is the thing that makes the product read as a tool rather than a website:
 * the whole migration is visible at once, and you can always see which phase is
 * yours to finish.
 *
 * It claims nothing it cannot prove. A phase gets `done` / `needs-you` only when a
 * screen has real state to justify it; everything else is `pending`, and screens
 * that do not exist yet say so out loud instead of pretending to be locked.
 */

export type PhaseId =
  | 'connect' | 'pair-envs' | 'map-users' | 'select-agents'
  | 'review' | 'connectors' | 'migrate' | 'report';

export type PhaseState = 'done' | 'current' | 'needs-you' | 'blocked' | 'pending' | 'not-built';

export interface PhaseStatus {
  state?: PhaseState;
  /** A count the phase can honestly report (agents, users, connectors). */
  count?: number | string;
}

/**
 * The phases, in the order the work actually happens.
 *
 * Two changes from the old wizard, both from how the flow really reads:
 *  - "Choose pair" is gone. The pair is fixed (Copilot Studio -> Gemini
 *    Enterprise), so a whole screen to confirm it was a screen that asked a
 *    question with one answer. The direction now shows on Connect itself, under
 *    the two cards, the moment both clouds are connected.
 *  - "Review what changes" is new, and it is the step that was missing between
 *    picking agents and configuring connectors: what will happen to each agent,
 *    what maps cleanly, what needs review, what cannot come across. Backed by the
 *    per-agent assessment the server already produces — see AgentAssessment.
 *    Reviewing fidelity AFTER migrating is how a customer gets surprised.
 */
export const PHASES: Array<{ id: PhaseId; label: string }> = [
  { id: 'connect', label: 'Connect clouds' },
  { id: 'pair-envs', label: 'Environments → projects' },
  { id: 'map-users', label: 'Map users' },
  { id: 'select-agents', label: 'Select agents' },
  { id: 'review', label: 'Review what changes' },
  { id: 'connectors', label: 'Connectors' },
  { id: 'migrate', label: 'Migrate' },
  { id: 'report', label: 'Fidelity report' },
];

/** Where each phase lives in the CURRENT ui, for the not-built-yet placeholder. */
export const OLD_ROUTE: Record<PhaseId, string> = {
  connect: '/connect',
  'pair-envs': '/map',
  'map-users': '/map-users',
  'select-agents': '/select-data',
  review: '/explore',
  connectors: '/connector-config',
  migrate: '/migrate',
  report: '/migrate',
};

/** Phases with a v2 screen. All eight exist now; the set stays because a mistyped
 *  or future phase must still be able to say "not built" rather than blank. */
export const BUILT: ReadonlySet<PhaseId> = new Set<PhaseId>([
  'connect', 'pair-envs', 'map-users', 'select-agents', 'review', 'connectors', 'migrate', 'report',
]);

const BADGE: Partial<Record<PhaseState, string>> = {
  'needs-you': 'NEEDS YOU',
  blocked: 'BLOCKED',
  'not-built': 'SOON',
};

export function PhaseRail({ current, status }: {
  current: PhaseId;
  /** Per-phase truth from the screens that have it. Omitted phases are pending. */
  status?: Partial<Record<PhaseId, PhaseStatus>>;
}) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const qs = params.toString();

  return (
    <nav className="v2-rail" aria-label="Migration phases">
      <div className="v2-rail-h">
        <div className="k">Migration</div>
        <div className="pair">
          <span>Copilot Studio</span>
          <span className="arrow" aria-hidden="true">↓</span>
          <span>Gemini Enterprise</span>
        </div>
      </div>

      <div className="v2-rail-l">Phases</div>
      {PHASES.map((p, i) => {
        const st = status?.[p.id];
        const built = BUILT.has(p.id);
        const state: PhaseState = p.id === current ? 'current' : st?.state ?? (built ? 'pending' : 'not-built');
        const badge = BADGE[state];
        return (
          <button
            type="button"
            key={p.id}
            className={`v2-phase ${state}`}
            aria-current={p.id === current ? 'step' : undefined}
            onClick={() => navigate(`/v2/${p.id}${qs ? `?${qs}` : ''}`)}
          >
            <span className="mk" aria-hidden="true">{state === 'done' ? '✓' : i + 1}</span>
            <span className="lb">{p.label}</span>
            {st?.count !== undefined && <span className="ct mono">{st.count}</span>}
            {badge && <span className="bd">{badge}</span>}
          </button>
        );
      })}

      <div className="v2-rail-f">
        <span className="swatch amber" aria-hidden="true" />
        amber = a phase only you can finish
      </div>
    </nav>
  );
}
