import { useState, type ReactNode } from 'react';
import { IcoArrowLeft, IcoCheck, IcoChevronDown, IcoMinus } from '../../icons.tsx';

/**
 * v2 primitives.
 *
 * Every phase screen is built from these, so a design change ("tighter rows",
 * "different chips") is one edit here instead of eight edits across eight screens.
 * Styling lives in design/v2.css — these components own structure and semantics
 * only, never colours.
 */

// ── panels ──────────────────────────────────────────────────────────────────

export function Panel({ children }: { children: ReactNode }) {
  return <div className="v2-panel">{children}</div>;
}

export function PanelHead({ title, sub, actions, accent }: {
  title: string;
  sub?: ReactNode;
  actions?: ReactNode;
  /** Brand-blue bold title, same as the reference's per-destination card
   *  heading (e.g. "Gmail") — opt-in so every other panel keeps its plain
   *  black title. */
  accent?: boolean;
}) {
  return (
    <div className="v2-panel-h">
      <div>
        <h2 className={accent ? 'accent' : undefined}>{title}</h2>
        {sub && <div className="sub">{sub}</div>}
      </div>
      {actions && <div className="sp">{actions}</div>}
    </div>
  );
}

// ── instrument band ─────────────────────────────────────────────────────────

export type BandTone = 'plain' | 'ok' | 'warn' | 'bad' | 'amber';

/**
 * One readout. `value` is a number the backend can produce, never a guess.
 *
 * `icon` is optional and pre-colored by the caller (a span with its own
 * `style={{color}}` wrapping one of the Ico* glyphs) — this stays generic
 * rather than growing its own color/tone logic for an icon, since callers
 * already pick meaningfully different hues per reading (blue for a neutral
 * count, red only once something has actually failed, etc.).
 */
export function BandCell({ label, value, note, tone = 'plain', icon, onClick, expanded }: {
  label: string;
  value: ReactNode;
  note?: string;
  tone?: BandTone;
  icon?: ReactNode;
  /**
   * Makes this readout the control that reveals what it counts. A number alone
   * says three; the only way to see WHICH three is to open the list, so the
   * number itself is the obvious place to click.
   */
  onClick?: () => void;
  /** Required with `onClick` — drives the caret AND `aria-expanded`, so what a
   *  sighted person sees and what a screen reader is told cannot drift apart. */
  expanded?: boolean;
}) {
  const body = (
    <>
      {icon && <span className="cell-icon">{icon}</span>}
      <div className="cell-body">
        <label>
          {label}
          {onClick && (
            // Not a decoration: a bare number gives no hint it can be opened.
            <span className={expanded ? 'cell-caret open' : 'cell-caret'} aria-hidden="true">
              <IcoChevronDown s={11} />
            </span>
          )}
        </label>
        <span className={`v${tone === 'plain' ? '' : ` ${tone}`}`}>{value}</span>
        {note && <span className="s">{note}</span>}
      </div>
    </>
  );
  const cls = icon ? 'cell with-icon' : 'cell';
  // A real <button>, not a div with onClick: it has to be reachable by keyboard
  // and announce its own expanded state, and every other BandCell on the band
  // stays a plain div so nothing that is only a readout claims to be operable.
  return onClick
    ? (
      <button type="button" className={`${cls} cell-btn`} onClick={onClick} aria-expanded={expanded}>
        {body}
      </button>
    )
    : <div className={cls}>{body}</div>;
}

export function Band({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    // Without a 6th "controls" cell, the real stat cells would otherwise sit
    // flush left with the rest of the row empty — `.v2-band--fill` (scoped to
    // this exact case, never applied when `aside` exists) spreads them to
    // occupy the whole row instead.
    <div className={aside ? 'v2-band' : 'v2-band v2-band--fill'}>
      {children}
      {aside && (
        <div className="cell grow">
          {/* An invisible label, not a magic padding-top: the real cells' content
              starts below THEIR label's own rendered line box, and a hardcoded
              pixel guess for that height drifts the moment the label's font or
              line-height changes. Reusing the exact same element and CSS rule
              guarantees the two rows start at the same Y regardless. */}
          <label aria-hidden="true" className="ghost">.</label>
          <div className="grow-row">{aside}</div>
        </div>
      )}
    </div>
  );
}

/** Progress under the band. `pct` is clamped so a bad number cannot overflow it. */
export function BandRule({ pct }: { pct: number }) {
  return (
    <div className="v2-rule">
      <i style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  );
}

// ── controls ────────────────────────────────────────────────────────────────

export type BtnTone = 'plain' | 'blue' | 'amber';

export function Btn({ children, onClick, tone = 'plain', disabled, wide, className, title }: {
  children: ReactNode;
  onClick?: () => void;
  tone?: BtnTone;
  disabled?: boolean;
  wide?: boolean;
  className?: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      className={`v2-btn${tone === 'plain' ? '' : ` ${tone}`}${wide ? ' wide' : ''}${className ? ` ${className}` : ''}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

/** Two-state mode switch (Agent | Manual and friends). */
// ── status ──────────────────────────────────────────────────────────────────

/** `you` is the amber one: it means a human must act, and nothing else may use it. */
export type ChipTone = 'plain' | 'ok' | 'warn' | 'run' | 'bad' | 'you';

export function Chip({ children, tone = 'plain', icon }: {
  children: ReactNode;
  tone?: ChipTone;
  /** Swaps the plain dot for a small icon (e.g. a tick for "paired") — only
   *  where a caller opts in, so every other chip keeps its dot unchanged. */
  icon?: ReactNode;
}) {
  return (
    <span className={`v2-chip${tone === 'plain' ? '' : ` ${tone}`}`}>
      {icon ?? <i />}
      {children}
    </span>
  );
}

// ── rows ────────────────────────────────────────────────────────────────────

/**
 * A selectable row. Deliberately a div with role=button: rows carry their own
 * action buttons, and a button inside a button is invalid markup that swallows
 * the inner click.
 *
 * `agentTarget` is the contract the agent cursor points at — see agent/driver.ts.
 *
 * `plain` drops the button semantics (role, tabIndex, pointer cursor, hover
 * wash) for a row that is read-only information, not a control — a lone
 * status readout with nothing to click reading as clickable was what made it
 * look like a stray card rather than plain text sitting in the page.
 */
export function Row({ glyph, name, sub, why, status, action, selected, onSelect, agentTarget, plain }: {
  glyph: ReactNode;
  name: string;
  sub?: string;
  why?: ReactNode;
  status?: ReactNode;
  action?: ReactNode;
  selected?: boolean;
  onSelect?: () => void;
  agentTarget?: string;
  plain?: boolean;
}) {
  return (
    <div
      role={plain ? undefined : 'button'}
      tabIndex={plain ? undefined : 0}
      className={`v2-row${selected ? ' pick' : ''}${plain ? ' plain' : ''}`}
      data-agent-target={agentTarget}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSelect?.(); }}
    >
      <span className="glyph" aria-hidden="true">{glyph}</span>
      <span className="nmw">
        <span className="nm">{name}</span>
        {sub && <span className="kind">{sub}</span>}
      </span>
      <span className="why">{why}</span>
      <span className="st">{status}</span>
      <span className="act">{action}</span>
    </div>
  );
}

/** A row that states a fact instead of listing an item (empty, error, loading). */
export function NoteRow({ children, tone }: { children: ReactNode; tone?: 'bad' | 'you' }) {
  // `you` is amber because it is the human's to resolve; `bad` is red because it is
  // a fact about the migration. The two colours never mean the same thing.
  const colour = tone === 'bad' ? 'var(--v2-fail)' : tone === 'you' ? 'var(--v2-amber)' : undefined;
  return (
    <div className="v2-row note">
      {/* The colour goes on the text, not the row: `.v2-row .why` sets its own
          colour, so tinting the parent silently loses. */}
      <span className="why" style={colour ? { color: colour } : undefined}>{children}</span>
    </div>
  );
}

// ── loading ─────────────────────────────────────────────────────────────────

/**
 * Row skeletons.
 *
 * Shown ONLY on a first read with nothing cached. Once data exists it stays on
 * screen during a refresh — replacing real rows with grey bars tells the reader
 * their data went away.
 */
export function SkeletonRows({ rows = 4, controls }: { rows?: number; controls?: boolean }) {
  return (
    <div aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }, (_, i) => (
        <div className="v2-row skel" key={i}>
          <span className="v2-skel g" />
          <span className="nmw">
            <span className="v2-skel l1" />
            <span className="v2-skel l2" />
          </span>
          <span className="why ctl">
            {controls ? <><span className="v2-skel ctl" /><span className="v2-skel ctl" /></> : <span className="v2-skel l3" />}
          </span>
          <span className="st"><span className="v2-skel chip" /></span>
        </div>
      ))}
    </div>
  );
}

/** A collapsed group of rows that are true but not actionable — kept reachable
 *  so nothing is hidden, kept shut so the list is about what you can do. */
export function Fold({ title, note, count, children, open: initial = false, padded }: {
  title: string;
  note?: string;
  count?: number;
  children: ReactNode;
  open?: boolean;
  /** The body is prose (e.g. `Note`s), not `Row`s that already carry their own
   *  edge-to-edge padding — without this the text sits flush against the panel
   *  border. */
  padded?: boolean;
}) {
  const [open, setOpen] = useState(initial);
  return (
    <div className={`v2-fold${open ? ' open' : ''}${padded ? ' pad' : ''}`}>
      <button type="button" className="hd" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="cv" aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span className="tl">{title}{count !== undefined ? ` (${count})` : ''}</span>
        {note && <span className="nt">{note}</span>}
      </button>
      {open && <div className="bd">{children}</div>}
    </div>
  );
}

// ── the agent's ledger ──────────────────────────────────────────────────────

/**
 * The list of steps the agent actually performed. Rendered in one place because
 * a new state (like the inconclusive `warn`) must not be handled on one screen
 * and forgotten on another — that is how a screen ends up showing a tick for
 * something nothing confirmed.
 */
export function Ledger({ lines, limit }: {
  lines: Array<{ text: string; state: 'ok' | 'live' | 'stop' | 'fail' | 'warn' }>;
  limit?: number;
}) {
  const shown = limit ? lines.slice(-limit) : lines;
  return (
    <>
      {shown.map((l, i) => (
        <div className={`v2-ldg ${l.state === 'ok' ? '' : l.state}`} key={`${i}-${l.text}`}>
          <span className="m" aria-hidden="true">
            {l.state === 'ok' ? '✓'
              : l.state === 'live' ? '◍'
                : l.state === 'stop' ? '◉'
                  : l.state === 'warn' ? '?' : '!'}
          </span>
          <span>{l.text}</span>
        </div>
      ))}
    </>
  );
}

// ── cloud marks ─────────────────────────────────────────────────────────────

/**
 * The two clouds, drawn rather than fetched.
 *
 * Inline SVG on purpose: a remote logo is a request that can fail, and a broken
 * image on the sign-in screen makes a working product look dead.
 *
 * Google is the GENUINE "G" (logo_googleg_48dp) -- the same paths and official
 * hexes Google ships on its own Sign-In button, copied verbatim from the asset
 * already in this repo at assets/icons/google.svg. It replaced a hand-drawn
 * four-colour spark that read as a generic sparkle rather than as Google, which
 * is the one thing this card exists to say. Inlined rather than imported so the
 * "drawn, not fetched" property above still holds: no bundler URL, no <img>, no
 * request that can fail. Microsoft stays a simple four-square mark -- it is
 * already unmistakable at 40px and needs no lockup.
 */
export function CloudMark({ platform }: { platform: 'microsoft' | 'google' }) {
  if (platform === 'microsoft') {
    return (
      <svg className="v2-mark" viewBox="0 0 24 24" role="img" aria-label="Microsoft">
        <rect x="1" y="1" width="10" height="10" fill="#f25022" />
        <rect x="13" y="1" width="10" height="10" fill="#7fba00" />
        <rect x="1" y="13" width="10" height="10" fill="#00a4ef" />
        <rect x="13" y="13" width="10" height="10" fill="#ffb900" />
      </svg>
    );
  }
  return (
    <svg className="v2-mark" viewBox="0 0 120 120" role="img" aria-label="Google">
      <path
        fill="#4285F4"
        d="M117.6,61.3636364 C117.6,57.1090909 117.218182,53.0181818 116.509091,49.0909091 L60,49.0909091 L60,72.3 L92.2909091,72.3 C90.9,79.8 86.6727273,86.1545455 80.3181818,90.4090909 L80.3181818,105.463636 L99.7090909,105.463636 C111.054545,95.0181818 117.6,79.6363636 117.6,61.3636364 L117.6,61.3636364 Z"
      />
      <path
        fill="#34A853"
        d="M60,120 C76.2,120 89.7818182,114.627273 99.7090909,105.463636 L80.3181818,90.4090909 C74.9454545,94.0090909 68.0727273,96.1363636 60,96.1363636 C44.3727273,96.1363636 31.1454545,85.5818182 26.4272727,71.4 L6.38181818,71.4 L6.38181818,86.9454545 C16.2545455,106.554545 36.5454545,120 60,120 L60,120 Z"
      />
      <path
        fill="#FBBC05"
        d="M26.4272727,71.4 C25.2272727,67.8 24.5454545,63.9545455 24.5454545,60 C24.5454545,56.0454545 25.2272727,52.2 26.4272727,48.6 L26.4272727,33.0545455 L6.38181818,33.0545455 C2.31818182,41.1545455 0,50.3181818 0,60 C0,69.6818182 2.31818182,78.8454545 6.38181818,86.9454545 L26.4272727,71.4 L26.4272727,71.4 Z"
      />
      <path
        fill="#EA4335"
        d="M60,23.8636364 C68.8090909,23.8636364 76.7181818,26.8909091 82.9363636,32.8363636 L100.145455,15.6272727 C89.7545455,5.94545455 76.1727273,0 60,0 C36.5454545,0 16.2545455,13.4454545 6.38181818,33.0545455 L26.4272727,48.6 C31.1454545,34.4181818 44.3727273,23.8636364 60,23.8636364 L60,23.8636364 Z"
      />
    </svg>
  );
}

// ── inspector ───────────────────────────────────────────────────────────────

export function Inspector({ children }: { children: ReactNode }) {
  return <aside className="v2-insp">{children}</aside>;
}

export function InspectorHead({ kind, title, status }: { kind: string; title: string; status?: ReactNode }) {
  return (
    <div className="v2-insp-h">
      <div className="k">{kind}</div>
      <h3>{title}</h3>
      {status}
    </div>
  );
}

export function InspectorSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="v2-insp-s">
      <h6>{title}</h6>
      {children}
    </div>
  );
}

export function KeyValue({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="v2-kv">
      <dt>{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}

export function Note({ children, tone }: { children: ReactNode; tone?: 'you' | 'bad' | 'ok' }) {
  // One marker for every note, regardless of tone — a dot next to a check next to a
  // question mark on adjacent lines read as inconsistent, not meaningful. The tone still
  // colors the dot (amber/red/green via the CSS class below), so the signal isn't lost.
  return (
    <div className={`v2-note${tone ? ` ${tone}` : ''}`}>
      <span className="m" aria-hidden="true">•</span>
      <span>{children}</span>
    </div>
  );
}

export function InspectorActions({ children }: { children: ReactNode }) {
  return <div className="v2-insp-act">{children}</div>;
}

/**
 * A plain checklist of what to do, not a status readout: a title phrased as an
 * instruction, one line saying why/what happens, and a dot that tells you which
 * single step is the one to act on right now — `active`, not just "not done yet".
 */
export function GuideSteps({ children }: { children: ReactNode }) {
  return <div className="v2-guide">{children}</div>;
}

export function GuideStep({ n, state = 'pending', title, children }: {
  n: number;
  state?: 'pending' | 'active' | 'done';
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className={`v2-guide-step${state !== 'pending' ? ` ${state}` : ''}`}>
      <span className="n" aria-hidden="true">{state === 'done' ? <IcoCheck s={10} /> : n}</span>
      <span className="tx">
        <span className="tl">{title}</span>
        {children && <span className="sb">{children}</span>}
      </span>
    </div>
  );
}

// ── wizard footer ───────────────────────────────────────────────────────────

/**
 * Back / Continue, plus the reason Continue is refused.
 *
 * A disabled Continue with no stated reason is the single most common way a
 * migration tool wastes someone's afternoon, so `blockedNote` is required
 * whenever `blocked` is set.
 */
export function WizardFooter({ onBack, onNext, nextLabel, blocked, note, backLabel = 'Previous' }: {
  onBack?: () => void;
  onNext?: () => void;
  /** Omitted on the LAST screen of the flow: a disabled Next that leads nowhere is
   *  a promise of a step that does not exist. */
  nextLabel?: string;
  blocked?: boolean;
  note: string;
  backLabel?: string;
}) {
  return (
    <div className="v2-wizard">
      {onBack && (
        <Btn className="back" onClick={onBack}>
          <span className="v2-ico-lb"><IcoArrowLeft s={14} />{backLabel}</span>
        </Btn>
      )}
      {/* Note BEFORE Next in DOM: `.note`'s margin-left:auto pushes itself and
          every sibling after it to the right edge as one group. With Next after
          it, that group is just the note; Next stayed stranded next to Back
          instead of anchoring the far right corner the way a wizard's primary
          action should. */}
      <span className={`note${blocked ? ' blocked' : ''}`}>{note}</span>
      {nextLabel && (
        <Btn tone="blue" className="next" onClick={onNext} disabled={blocked}>{nextLabel}</Btn>
      )}
    </div>
  );
}

// ── modal ───────────────────────────────────────────────────────────────────

export function Modal({ label, glyph, title, sub, onClose, body, footer }: {
  label: string;
  glyph: ReactNode;
  title: string;
  sub?: ReactNode;
  onClose: () => void;
  body: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <>
      <div className="v2-scrim" onClick={onClose} />
      <div className="v2-modal" role="dialog" aria-modal="true" aria-label={label}>
        <div className="v2-modal-h">
          <span className="glyph" aria-hidden="true">{glyph}</span>
          <div>
            <h3>{title}</h3>
            {sub && <div className="sub">{sub}</div>}
          </div>
          <button type="button" className="x" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="v2-modal-b">{body}</div>
        {footer && <div className="v2-modal-f">{footer}</div>}
      </div>
    </>
  );
}

// ── selection ───────────────────────────────────────────────────────────────

/**
 * Tri-state tick. `mixed` is not decoration: a group where some children are
 * selected must not look like a group where all of them are, or the customer
 * migrates more (or less) than they think.
 */
export function Tick({ state, onToggle, label }: {
  state: 'on' | 'off' | 'mixed';
  onToggle?: () => void;
  label?: string;
}) {
  return (
    <span
      role="checkbox"
      aria-checked={state === 'mixed' ? 'mixed' : state === 'on'}
      aria-label={label}
      tabIndex={0}
      className={`v2-tick ${state}`}
      onClick={(e) => { e.stopPropagation(); onToggle?.(); }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle?.(); } }}
    >
      {/* A real SVG glyph, not a Unicode "✓"/"–" — a plain text checkmark
          renders inconsistently across fonts (too heavy, off-center) and was
          the one place this control didn't match the rest of the app's
          hand-tuned thin-stroke icon set. */}
      {state === 'on' && <IcoCheck s={7} />}
      {state === 'mixed' && <IcoMinus s={7} />}
    </span>
  );
}

export function Select({ value, options, onChange, placeholder, disabled, agentTarget }: {
  value: string;
  options: Array<{ id: string; label: string; disabled?: boolean }>;
  onChange: (id: string) => void;
  placeholder?: string;
  disabled?: boolean;
  agentTarget?: string;
}) {
  return (
    <select
      className="v2-select"
      value={value}
      disabled={disabled}
      data-agent-target={agentTarget}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{placeholder ?? '—'}</option>
      {options.map((o) => (
        <option key={o.id} value={o.id} disabled={o.disabled}>{o.label}</option>
      ))}
    </select>
  );
}

/** The bar above a list: how much is selected, and the bulk actions. */
export function SelectBar({ summary, children }: { summary: ReactNode; children?: ReactNode }) {
  return (
    <div className="v2-selbar">
      <span className="big">{summary}</span>
      {children && <span className="sp">{children}</span>}
    </div>
  );
}

/** A collapsible group of rows (an environment, a project, a cloud). */
export function Group({ title, id, count, open, onToggleOpen, tick, children }: {
  title: string;
  id?: string;
  count?: ReactNode;
  open: boolean;
  onToggleOpen: () => void;
  tick?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`v2-grp${open ? '' : ' shut'}`}>
      <div className="grp-h" onClick={onToggleOpen}>
        {tick}
        <span>
          <span className="nm">{title}</span>
          {id && <span className="id">{id}</span>}
        </span>
        {count !== undefined && <span className="cnt mono">{count}</span>}
        <span className="caret" aria-hidden="true">▼</span>
      </div>
      <div className="grp-b">{children}</div>
    </div>
  );
}
