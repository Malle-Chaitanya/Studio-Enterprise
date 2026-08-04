export type PanelMode = 'agent' | 'manual';

interface Props {
  mode: PanelMode;
  onChange: (mode: PanelMode) => void;
}

export function ModeToggle({ mode, onChange }: Props) {
  return (
    <div className="mode-toggle">
      <button
        className={`mode-toggle-btn${mode === 'agent' ? ' active' : ''}`}
        onClick={() => onChange('agent')}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2a4 4 0 014 4v2H8V6a4 4 0 014-4z"/>
          <rect x="4" y="8" width="16" height="12" rx="2"/>
          <circle cx="9" cy="14" r="1.5" fill="currentColor" stroke="none"/>
          <circle cx="15" cy="14" r="1.5" fill="currentColor" stroke="none"/>
        </svg>
        Agent
      </button>
      <button
        className={`mode-toggle-btn${mode === 'manual' ? ' active' : ''}`}
        onClick={() => onChange('manual')}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="16" y1="13" x2="8" y2="13"/>
          <line x1="16" y1="17" x2="8" y2="17"/>
        </svg>
        Manual
      </button>
    </div>
  );
}
