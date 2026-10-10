import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
// Imported by the shell, not by each screen: every v2 phase renders inside this,
// so the stylesheet arrives exactly once no matter how many screens exist.
import '../../design/v2.css';
import { AgentDock } from '../agent/AgentDock.tsx';
import { DrivingLayer } from '../agent/DrivingLayer.tsx';
import type { AgentDriverState } from '../../agent/driver.ts';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useSource } from '../../v2/data/index.ts';
import { useResource } from '../../v2/data/cache.ts';
import { fetchSelection } from '../../api.ts';
import { signOut } from '../../authGuard.ts';
import { IcoChevronDown, IcoLogout, IcoUser } from '../../icons.tsx';
import { derivePhaseStatus } from './phaseState.ts';
import { PhaseRail, type PhaseId, type PhaseStatus } from './PhaseRail.tsx';

/** Persisted so the rail does not snap back open on every page navigation. */
const RAIL_COLLAPSED_KEY = 'csge_v2_rail_collapsed';

function readCollapsed(): boolean {
  try { return localStorage.getItem(RAIL_COLLAPSED_KEY) === '1'; } catch { return false; }
}

/**
 * The v2 shell: rail, work area, inspector, agent dock and takeover chrome.
 *
 * Every phase screen renders inside this, so the frame is identical across all
 * eight and a change to it lands everywhere at once. Screens supply their canvas
 * and their inspector; nothing else.
 */
/**
 * Derived first, then the screen's own claims — but only the claims it actually
 * MAKES.
 *
 * A plain object spread was wrong here: screens write `connectors: blockers ? {...}
 * : undefined`, and spreading that undefined DELETED what the shared derivation had
 * worked out. That is why the Connectors phase kept losing its tick the moment you
 * reached Migrate — the screen was overwriting a correct answer with "I don't know".
 */
function mergeStatus(
  derived: Partial<Record<PhaseId, PhaseStatus>>,
  own?: Partial<Record<PhaseId, PhaseStatus>>,
): Partial<Record<PhaseId, PhaseStatus>> {
  const out = { ...derived };
  for (const [k, v] of Object.entries(own ?? {})) {
    if (v !== undefined) out[k as PhaseId] = v;
  }
  return out;
}

export function V2Layout({
  phase,
  phaseStatus,
  agent,
  suggestions,
  onPrompt,
  onStop,
  manual,
  quiet,
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
  /**
   * Suppress the takeover chrome — edges, cursor, caption — while still keeping
   * the ledger.
   *
   * For screens where the work is a server-side PROCESS rather than the agent
   * driving this UI. Washing the page out while a migration sat at 0% read as a
   * broken screen, not a busy one: nothing was being driven, so nothing should
   * have looked driven.
   */
  quiet?: boolean;
  canvas: ReactNode;
  inspector: ReactNode;
  toast?: string;
}) {
  const source = useSource();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const session = params.get('session') ?? '';
  const waiting = !quiet && agent.mode === 'waiting';
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggleCollapsed = () => setCollapsed((v) => {
    const next = !v;
    try { localStorage.setItem(RAIL_COLLAPSED_KEY, next ? '1' : '0'); } catch { /* private mode */ }
    return next;
  });

  // Account menu: a dropdown, not a direct-click button — "Log out" lives inside
  // it so a stray click on the avatar can't sign anyone out by accident.
  const [accountOpen, setAccountOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!accountOpen) return;
    const onClick = (e: MouseEvent) => {
      if (accountRef.current && !accountRef.current.contains(e.target as Node)) setAccountOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [accountOpen]);

  // Read once for the whole shell, cached like everything else, so the rail can
  // tick Map users on EVERY screen instead of only on the one that saved it. One
  // small GET per session; a failure leaves the phase unclaimed, never wrong.
  useResource(`idmap:${session}`, () => source.users.mappedCount(session), Boolean(session));
  // The selection as the SERVER has it. sessionStorage is per tab, so without this
  // resuming a session in a new tab showed Select agents as untouched.
  // Guarded on the seam: this one talks to the real API directly rather than through
  // `source`, so in fixture mode it would fire a real request and 401. Canned data
  // must never touch the network.
  useResource(`sel:${session}`, () => fetchSelection(session), Boolean(session) && !source.isFixture);

  return (
    <div
      className={`v2${waiting ? ' waiting' : ''}${collapsed ? ' rail-collapsed' : ''}`}
      style={{ '--v2-rail-w': collapsed ? '68px' : '232px' } as CSSProperties}
    >
      <div className="v2-frame">
        {/* Derived first, then the screen's own claims on top: the rail must read
            the same on every screen, so a screen may refine it but not contradict
            what the cached state already proves. */}
        <PhaseRail
          current={phase}
          status={mergeStatus(derivePhaseStatus(session, phase), phaseStatus)}
          collapsed={collapsed}
          onToggleCollapsed={toggleCollapsed}
        />
        <div className="v2-work">
          {/* The sidebar now carries the logo, so this bar is deliberately slim:
              status + sign out, sitting only beside the rail, not above it. */}
          <header className="v2-topbar">
            <h1 className="v2-topbar-title">Agents Migration</h1>
            <span className="v2-topbar-sp" />
            <span className="v2-topbar-status">
              <span className="statusdot" />
              Online
            </span>
            <div className="v2-account" ref={accountRef}>
              <button
                className="v2-account-trigger"
                aria-expanded={accountOpen}
                aria-haspopup="menu"
                onClick={() => setAccountOpen((v) => !v)}
              >
                <span className="v2-account-avatar"><IcoUser s={14} /></span>
                <span className="v2-account-label">CF</span>
                <IcoChevronDown s={12} />
              </button>
              {accountOpen && (
                <div className="v2-account-menu" role="menu">
                  <button
                    className="v2-account-item"
                    role="menuitem"
                    onClick={() => void signOut(navigate)}
                  >
                    <IcoLogout s={13} />
                    Log out
                  </button>
                </div>
              )}
            </div>
          </header>
          {/* `.v2-canvas`'s default bottom padding reserves room for the floating
              AgentDock. `manual` screens never render that dock, so the reserve was
              150px of dead space at the foot of every page - exactly what forced an
              outer page scroll even after a screen's own list was already bounded
              and scrolling itself (Map users' row list, for one). */}
          <div className={`v2-canvas${manual ? ' compact' : ''}`}>{canvas}</div>
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

      {!quiet && <DrivingLayer state={agent} />}
      {!manual && (
        <AgentDock state={agent} suggestions={suggestions} onSubmit={onPrompt} onStop={onStop} />
      )}
    </div>
  );
}
