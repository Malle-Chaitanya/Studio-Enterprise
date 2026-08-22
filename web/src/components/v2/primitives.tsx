import type { ReactNode } from 'react';

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
export function NoteRow({ children, tone }: { children: ReactNode; tone?: 'bad' }) {
  return (
    <div className="v2-row" style={tone === 'bad' ? { color: 'var(--v2-fail)' } : undefined}>
      <span className="why">{children}</span>
    </div>
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
  nextLabel: string;
  blocked?: boolean;
  note: string;
  backLabel?: string;
}) {
  return (
    <div className="v2-wizard">
      {onBack && <Btn className="back" onClick={onBack}>{backLabel}</Btn>}
      <Btn tone="blue" className="next" onClick={onNext} disabled={blocked}>{nextLabel}</Btn>
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
