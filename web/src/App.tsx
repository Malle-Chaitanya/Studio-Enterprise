import { useState } from 'react';
import { Outlet, Route, Routes, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ChoosePair } from './pages/ChoosePair.tsx';
import { Connect } from './pages/Connect.tsx';
import { Connectors } from './pages/Connectors.tsx';
import { Explore } from './pages/Explore.tsx';
import { Home } from './pages/Home.tsx';
import { Login } from './pages/Login.tsx';
import { Migrate } from './pages/Migrate.tsx';
import { SelectData } from './pages/SelectData.tsx';
import { SelectMap } from './pages/SelectMap.tsx';
import { WorkflowsPage } from './components/workflows/WorkflowsPage.tsx';
import { TwoPanelShell } from './components/layout/TwoPanelShell.tsx';
import { AgentChat } from './components/agent/AgentChat.tsx';
import { ModeToggle, type PanelMode } from './components/agent/ModeToggle.tsx';

// ---------------------------------------------------------------------------
// PanelHeader
// ---------------------------------------------------------------------------

interface PanelHeaderProps {
  title: string;
  badge?: string;
  status?: string;
  statusColor?: string;
  icon?: React.ReactNode;
}

function PanelHeader({ title, badge, status, statusColor, icon }: PanelHeaderProps) {
  return (
    <div className="panel-strip">
      <div className="panel-strip-left">
        <span className="panel-strip-drag" aria-hidden>⋮⋮</span>
        {icon && <span className="panel-strip-icon">{icon}</span>}
        <span className="panel-strip-title">{title}</span>
        {badge && <span className="panel-strip-badge">{badge}</span>}
      </div>
      {status && (
        <div className="panel-strip-status">
          <span
            className="panel-strip-dot"
            style={{ background: statusColor ?? '#6b7280' }}
          />
          {status}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// RobotIcon — simple 16×16 agent/robot SVG
// ---------------------------------------------------------------------------

function RobotIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {/* head */}
      <rect x="5" y="7" width="14" height="10" rx="2" />
      {/* eyes */}
      <circle cx="9" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="12" r="1" fill="currentColor" stroke="none" />
      {/* antenna */}
      <line x1="12" y1="7" x2="12" y2="3" />
      <circle cx="12" cy="2.5" r="1" fill="currentColor" stroke="none" />
      {/* body connector */}
      <line x1="8" y1="17" x2="8" y2="20" />
      <line x1="16" y1="17" x2="16" y2="20" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// AppHeader
// ---------------------------------------------------------------------------

function AppHeader() {
  const navigate = useNavigate();

  const rawEmail = localStorage.getItem('cf_user_email') ?? '';
  const initials = rawEmail.length >= 2
    ? rawEmail.slice(0, 2).toUpperCase()
    : 'CF';
  const displayName = rawEmail.includes('@')
    ? rawEmail.split('@')[0]
    : 'Admin User';

  const signOut = () => {
    fetch('/api/logout', { method: 'POST' }).catch(() => {});
    navigate('/');
  };

  return (
    <header className="appheader">
      <img
        src="/assets/logo.png"
        alt="CloudFuze"
        className="hlogo-img"
        onClick={() => navigate('/home')}
      />
      <span className="hdivider" />
      <span className="applogo" style={{ cursor: 'pointer' }} onClick={() => navigate('/home')}>
        CloudFuze
      </span>
      <nav className="appnav">
        <button className="appnav-link" onClick={() => navigate('/home')}>Migration</button>
        <button className="appnav-link" onClick={() => navigate('/workflows')}>Workflows</button>
      </nav>
      <span className="hstatus">
        <span className="statusdot" style={{ background: '#16a34a' }} />
        <span className="hstatus-label">Idle</span>
        <span className="hdivider" style={{ margin: '0 8px' }} />
        <span className="havatar">{initials}</span>
        <span className="hdisplayname">{displayName}</span>
        <button className="hsignout" onClick={signOut}>
          &#x2192; Sign out
        </button>
      </span>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Stepper — 5 steps
// ---------------------------------------------------------------------------

const STEPS: { label: string; paths: string[] }[] = [
  { label: 'Connect Clouds',     paths: ['/home', '/connect'] },
  { label: 'Map Environments',   paths: ['/map', '/explore', '/connectors'] },
  { label: 'Select',             paths: ['/select-data'] },
  { label: 'Migrate',            paths: ['/migrate'] },
  { label: 'Report',             paths: [] },
];

function Stepper() {
  const { pathname } = useLocation();
  const activeIdx = STEPS.findIndex((s) => s.paths.includes(pathname));
  const active = activeIdx === -1 ? 0 : activeIdx;
  return (
    <div className="wizard">
      {STEPS.map((s, i) => (
        <div key={i} className={`wstep ${i < active ? 'done' : i === active ? 'active' : 'todo'}`}>
          <span className="wstep-num">{i < active ? '✓' : i + 1}</span>
          <span className="wstep-label">{s.label}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ManualGuide
// ---------------------------------------------------------------------------

function ManualGuide() {
  const { pathname } = useLocation();

  const hints: Record<string, { title: string; steps: string[] }> = {
    '/home': {
      title: 'Step 1: Connect Clouds',
      steps: [
        'Click Connect under Microsoft to sign in with your M365 admin account.',
        'Click Connect under Google to sign in with your Google Workspace admin.',
        'Both connections must show ✓ before you continue.',
      ],
    },
    '/map': {
      title: 'Step 2: Map Environments',
      steps: [
        'Select which Copilot Studio environments to migrate.',
        'For each environment, choose the target GCP project and Gemini app.',
        'Click Next when all environments are mapped.',
      ],
    },
    '/select-data': {
      title: 'Step 3: Select Agents & Flows',
      steps: [
        'All agents in the chosen environments are listed.',
        'Deselect any agents you want to skip.',
        'Use search to find specific agents by name.',
      ],
    },
    '/migrate': {
      title: 'Step 4: Run Migration',
      steps: [
        'Run a Dry Run first to preview what will be created.',
        'Review the per-agent plan and fix any warnings.',
        'Run Live Migration to create real Gemini agents.',
        'Download the report when done.',
      ],
    },
    '/workflows': {
      title: 'Cloud Workflows',
      steps: [
        'Lists all migrated Cloud Workflows in your GCP project.',
        'Click Run Workflow to trigger a workflow with custom arguments.',
        'Active workflows can be triggered; disabled ones must be re-enabled in GCP Console.',
      ],
    },
  };

  const hint = hints[pathname] ?? {
    title: 'Migration Guide',
    steps: ['Follow the steps in the left panel to complete your migration.'],
  };

  return (
    <div className="manual-guide">
      <div className="manual-guide-icon">
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
        </svg>
      </div>
      <div className="manual-guide-title">{hint.title}</div>
      <ol className="manual-guide-steps">
        {hint.steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RightPanel
// ---------------------------------------------------------------------------

function RightPanel({ session }: { session: string }) {
  const [mode, setMode] = useState<PanelMode>('agent');

  return (
    <div className="right-panel">
      <PanelHeader title="CloudFuze Migration" />
      <div className="right-panel-body">
        <ModeToggle mode={mode} onChange={setMode} />
        {mode === 'agent' ? (
          <AgentChat session={session} />
        ) : (
          <ManualGuide />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AppShell
// ---------------------------------------------------------------------------

/** Layout for in-app pages: header + two-panel shell (left = wizard, right = agent/manual) */
function AppShell() {
  const [params] = useSearchParams();
  const session = params.get('session') ?? '';

  const leftPanel = (
    <div className="left-panel">
      <PanelHeader
        title="Migration Agent"
        badge="BETA"
        status="Ready"
        statusColor="#16a34a"
        icon={<RobotIcon />}
      />
      <Stepper />
      <div className="shell">
        <Outlet />
      </div>
    </div>
  );

  return (
    <>
      <AppHeader />
      <div className="workspace">
        <TwoPanelShell
          left={leftPanel}
          right={<RightPanel session={session} />}
          defaultSplit={60}
        />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// App — root router
// ---------------------------------------------------------------------------

export function App() {
  return (
    <Routes>
      {/* Full-screen login (no header) */}
      <Route path="/" element={<Login />} />
      {/* In-app pages share header + two-panel shell */}
      <Route element={<AppShell />}>
        <Route path="/home" element={<Home />} />
        <Route path="/pair" element={<ChoosePair />} />
        <Route path="/select-data" element={<SelectData />} />
        <Route path="/map" element={<SelectMap />} />
        <Route path="/connect" element={<Connect />} />
        <Route path="/explore" element={<Explore />} />
        <Route path="/connectors" element={<Connectors />} />
        <Route path="/migrate" element={<Migrate />} />
        <Route path="/workflows" element={<WorkflowsPage />} />
      </Route>
    </Routes>
  );
}
