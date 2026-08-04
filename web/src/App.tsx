import { Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { ChoosePair } from './pages/ChoosePair.tsx';
import { Connect } from './pages/Connect.tsx';
import { Connectors } from './pages/Connectors.tsx';
import { Explore } from './pages/Explore.tsx';
import { Home } from './pages/Home.tsx';
import { Login } from './pages/Login.tsx';
import { Migrate } from './pages/Migrate.tsx';
import { SelectData } from './pages/SelectData.tsx';
import { SelectMap } from './pages/SelectMap.tsx';

function AppHeader() {
  const navigate = useNavigate();
  const signOut = () => {
    fetch('/api/logout', { method: 'POST' }).catch(() => {});
    navigate('/');
  };
  return (
    <header className="appheader">
      <img src="/assets/logo.png" alt="CloudFuze" className="hlogo-img" onClick={() => navigate('/home')} />
      <span className="hdivider" />
      <span className="applogo" style={{ cursor: 'pointer' }} onClick={() => navigate('/home')}>
        CloudFuze
      </span>
      <span className="hstatus">
        <span className="statusdot" />
        Idle
        <span className="hdivider" style={{ margin: '0 2px' }} />
        <span className="havatar">CF</span>
        <button className="hsignout" onClick={signOut}>
          ⎋ Sign out
        </button>
      </span>
    </header>
  );
}

const STEPS = [
  { label: 'Connect Platforms', paths: ['/home', '/connect'] },
  { label: 'Choose Pair', paths: ['/pair'] },
  { label: 'Select & Map', paths: ['/map', '/explore', '/connectors'] },
  { label: 'Select Data', paths: ['/select-data'] },
  { label: 'Dry Run', paths: [] as string[] },
  { label: 'Live Migration', paths: ['/migrate'] },
  { label: 'Report', paths: [] as string[] },
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

/** Layout for in-app pages: fixed header + step indicator + workflow content. */
function AppShell() {
  return (
    <>
      <AppHeader />
      <div className="workspace">
        <Stepper />
        <div className="shell">
          <Outlet />
        </div>
      </div>
    </>
  );
}

export function App() {
  return (
    <Routes>
      {/* Full-screen login (no header) */}
      <Route path="/" element={<Login />} />
      {/* In-app pages share header + stepper + shell */}
      <Route element={<AppShell />}>
        <Route path="/home" element={<Home />} />
        <Route path="/pair" element={<ChoosePair />} />
        <Route path="/select-data" element={<SelectData />} />
        <Route path="/map" element={<SelectMap />} />
        <Route path="/connect" element={<Connect />} />
        <Route path="/explore" element={<Explore />} />
        <Route path="/connectors" element={<Connectors />} />
        <Route path="/migrate" element={<Migrate />} />
      </Route>
    </Routes>
  );
}
