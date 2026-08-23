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
  | 'connect' | 'map-users' | 'select-agents'
  | 'connectors' | 'migrate';

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
 *  - "Environments → projects" is gone the same way, and for a sharper reason: the
 *    pairing table now sits on Connect, so keeping the phase too showed the very
 *    same table on two consecutive screens. /v2/pair-envs still resolves — it
 *    redirects to Connect rather than 404ing a link someone may have kept.
 *  - "Review what changes" was briefly its own phase and is no longer one: it read
 *    as an extra step for information that belongs beside the run. The per-agent
 *    assessment did NOT go away — Connectors runs it and shows every lost and
 *    needs-review finding in its inspector, so fidelity is still seen BEFORE the
 *    first write. Reviewing fidelity only AFTER migrating is how a customer gets
 *    surprised, and that is still the thing to avoid.
 */
export const PHASES: Array<{ id: PhaseId; label: string }> = [
  { id: 'connect', label: 'Connect clouds' },
  { id: 'map-users', label: 'Map users' },
  { id: 'select-agents', label: 'Select agents' },
  { id: 'connectors', label: 'Connectors' },
  { id: 'migrate', label: 'Migrate' },
];

/** Where each phase lives in the CURRENT ui, for the not-built-yet placeholder. */
export const OLD_ROUTE: Record<PhaseId, string> = {
  connect: '/connect',
  'map-users': '/map-users',
  'select-agents': '/select-data',
  connectors: '/connector-config',
  migrate: '/migrate',
};

/** Phases with a v2 screen. All seven exist now; the set stays because a mistyped
 *  or future phase must still be able to say "not built" rather than blank. */
export const BUILT: ReadonlySet<PhaseId> = new Set<PhaseId>([
  'connect', 'map-users', 'select-agents', 'connectors', 'migrate',
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
        <div className="lg">
          <span className="mk done" aria-hidden="true">✓</span>
          <span>done — we read something that proves it</span>
        </div>
        <div className="lg">
          <span className="mk" aria-hidden="true">3</span>
          <span>just the step number — not done yet</span>
        </div>
        <div className="lg">
          <span className="swatch amber" aria-hidden="true" />
          <span>amber — only you can finish it</span>
        </div>
      </div>
    </nav>
  );
}
