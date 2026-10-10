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
  | 'connectors' | 'migrate' | 'report';

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
  // After Migrate, because it is the thing you read once the run is over. It is a
  // destination, not a step: /v2/report with no run id resolves the latest one.
  { id: 'report', label: 'Report' },
];

/** Where each phase lives in the CURRENT ui, for the not-built-yet placeholder. */
export const OLD_ROUTE: Record<PhaseId, string> = {
  connect: '/connect',
  'map-users': '/map-users',
  'select-agents': '/select-data',
  connectors: '/connector-config',
  migrate: '/migrate',
  // The old UI has no report screen of its own -- the run page was where results lived.
  report: '/migrate',
};

/** Phases with a v2 screen. All seven exist now; the set stays because a mistyped
 *  or future phase must still be able to say "not built" rather than blank. */
export const BUILT: ReadonlySet<PhaseId> = new Set<PhaseId>([
  'connect', 'map-users', 'select-agents', 'connectors', 'migrate', 'report',
]);

const BADGE: Partial<Record<PhaseState, string>> = {
  'needs-you': 'NEEDS YOU',
  blocked: 'BLOCKED',
  'not-built': 'SOON',
};

/** One simple line-icon per phase, matching the brand guide's lineicons.com
 *  style — a mark for what the step IS, not the step's number. The status
 *  colour (done/current/needs-you/blocked) still comes from the badge
 *  background, so "whose turn is it" stays unambiguous. */
const ICON: Record<PhaseId, JSX.Element> = {
  connect: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 17H7A5 5 0 0 1 7 7h2M15 7h2a5 5 0 1 1 0 10h-2M8 12h8" />
    </svg>
  ),
  'map-users': (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="8" r="3" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
      <circle cx="18" cy="9" r="2.2" /><path d="M15.5 14.2c2.6.3 4.5 2.4 4.5 5.3" />
    </svg>
  ),
  'select-agents': (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="8" width="16" height="11" rx="2" /><path d="M12 8V4M9 4h6" />
      <circle cx="9" cy="13.5" r="1.2" fill="currentColor" stroke="none" /><circle cx="15" cy="13.5" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  ),
  connectors: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 4v3M15 4v3M9 20v-3M15 20v-3M4 9h3M4 15h3M20 9h-3M20 15h-3" />
      <rect x="7" y="7" width="10" height="10" rx="2" />
    </svg>
  ),
  migrate: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 12h13M13 6l6 6-6 6" />
    </svg>
  ),
  report: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 4h11l3 3v13H5z" /><path d="M9 12h6M9 16h6M9 8h3" />
    </svg>
  ),
};

const COLLAPSE_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" />
  </svg>
);

export function PhaseRail({ current, status, collapsed, onToggleCollapsed }: {
  current: PhaseId;
  /** Per-phase truth from the screens that have it. Omitted phases are pending. */
  status?: Partial<Record<PhaseId, PhaseStatus>>;
  /** Icon-only mode — the whole sidebar (logo, labels, section header) narrows
   *  to just the icon column. Owned by V2Layout, which also offsets the topbar
   *  by the same width, so the two never disagree about how wide the rail is. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const qs = params.toString();

  return (
    // Width and the collapsed-state descendant rules both key off `.rail-collapsed`
    // on the outer `.v2` wrapper (set by V2Layout) — nothing extra is needed here.
    <nav className="v2-rail" aria-label="Migration phases">
      <div className="v2-rail-brand" onClick={() => navigate(`/v2/connect${qs ? `?${qs}` : ''}`)}>
        <span className="v2-rail-mark" aria-hidden="true" />
        <span className="v2-rail-word">CloudFuze</span>
      </div>
      {PHASES.map((p) => {
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
            <span className="mk" aria-hidden="true">{ICON[p.id]}</span>
            {!collapsed && (
              <>
                <span className="lb">{p.label}</span>
                {badge && <span className="bd">{badge}</span>}
              </>
            )}
            {/* Collapsed mode has no visible label, so the name has to surface
                somewhere — a hover bubble to the right, same idea as a native
                title tooltip but styled and never clipped by the rail's edge. */}
            {collapsed && <span className="v2-phase-tip" role="tooltip">{p.label}</span>}
          </button>
        );
      })}

      {onToggleCollapsed && (
        <button
          type="button"
          className="v2-rail-toggle"
          onClick={onToggleCollapsed}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {COLLAPSE_ICON}
        </button>
      )}
    </nav>
  );
}
