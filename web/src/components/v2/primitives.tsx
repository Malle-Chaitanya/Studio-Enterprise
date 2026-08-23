import { useState, type ReactNode } from 'react';

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

export function PanelHead({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="v2-panel-h">
      <div>
        <h2>{title}</h2>
        {sub && <div className="sub">{sub}</div>}
      </div>
      {actions && <div className="sp">{actions}</div>}
    </div>
  );
}

// ── instrument band ─────────────────────────────────────────────────────────

export type BandTone = 'plain' | 'ok' | 'warn' | 'bad' | 'amber';

/** One readout. `value` is a number the backend can produce, never a guess. */
export function BandCell({ label, value, note, tone = 'plain' }: {
  label: string;
  value: ReactNode;
  note?: string;
  tone?: BandTone;
}) {
  return (
    <div className="cell">
      <label>{label}</label>
      <span className={`v${tone === 'plain' ? '' : ` ${tone}`}`}>{value}</span>
      {note && <span className="s">{note}</span>}
    </div>
  );
}

export function Band({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="v2-band">
      {children}
      {aside && <div className="cell grow">{aside}</div>}
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
export function Toggle<T extends string>({ value, options, onChange }: {
  value: T;
  options: Array<{ id: T; label: string }>;
  onChange: (id: T) => void;
}) {
  return (
    <>
      {options.map((o) => (
        <Btn key={o.id} tone={o.id === value ? 'blue' : 'plain'} onClick={() => onChange(o.id)}>
          {o.label}
        </Btn>
      ))}
    </>
  );
}

// ── status ──────────────────────────────────────────────────────────────────

/** `you` is the amber one: it means a human must act, and nothing else may use it. */
export type ChipTone = 'plain' | 'ok' | 'warn' | 'run' | 'bad' | 'you';

export function Chip({ children, tone = 'plain' }: { children: ReactNode; tone?: ChipTone }) {
  return (
    <span className={`v2-chip${tone === 'plain' ? '' : ` ${tone}`}`}>
      <i />
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
 */
export function Row({ glyph, name, sub, why, status, action, selected, onSelect, agentTarget }: {
  glyph: ReactNode;
  name: string;
  sub?: string;
  why?: ReactNode;
  status?: ReactNode;
  action?: ReactNode;
  selected?: boolean;
  onSelect?: () => void;
  agentTarget?: string;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      className={`v2-row${selected ? ' pick' : ''}`}
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
export function Fold({ title, note, count, children, open: initial = false }: {
  title: string;
  note?: string;
  count?: number;
  children: ReactNode;
  open?: boolean;
}) {
  const [open, setOpen] = useState(initial);
  return (
    <div className={`v2-fold${open ? ' open' : ''}`}>
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
 * image on the sign-in screen makes a working product look dead. These are simple
 * vendor-coloured marks, not exact brand lockups.
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
    <svg className="v2-mark" viewBox="0 0 24 24" role="img" aria-label="Google">
      <path d="M12 2.5 13.9 9 20.5 12 13.9 15 12 21.5 10.1 15 3.5 12 10.1 9Z" fill="#4285f4" />
      <path d="M12 2.5 13.9 9 12 12Z" fill="#ea4335" />
      <path d="M20.5 12 13.9 15 12 12Z" fill="#fbbc04" />
      <path d="M12 21.5 10.1 15 12 12Z" fill="#34a853" />
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
  const mark = tone === 'you' ? '?' : tone === 'bad' ? '!' : tone === 'ok' ? '✓' : '•';
  return (
    <div className={`v2-note${tone ? ` ${tone}` : ''}`}>
      <span className="m" aria-hidden="true">{mark}</span>
      <span>{children}</span>
    </div>
  );
}

export function InspectorActions({ children }: { children: ReactNode }) {
  return <div className="v2-insp-act">{children}</div>;
}

// ── wizard footer ───────────────────────────────────────────────────────────

/**
 * Back / Continue, plus the reason Continue is refused.
 *
 * A disabled Continue with no stated reason is the single most common way a
 * migration tool wastes someone's afternoon, so `blockedNote` is required
 * whenever `blocked` is set.
 */
export function WizardFooter({ onBack, onNext, nextLabel, blocked, note, backLabel = 'Back' }: {
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
      {onBack && <Btn className="back" onClick={onBack}>{backLabel}</Btn>}
      {nextLabel && (
        <Btn tone="blue" className="next" onClick={onNext} disabled={blocked}>{nextLabel}</Btn>
      )}
      <span className={`note${blocked ? ' blocked' : ''}`}>{note}</span>
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
  footer: ReactNode;
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
        <div className="v2-modal-f">{footer}</div>
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
      {state === 'on' ? '✓' : state === 'mixed' ? '–' : ''}
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
