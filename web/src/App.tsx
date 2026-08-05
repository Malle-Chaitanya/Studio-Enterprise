import { Outlet, Route, Routes, useNavigate } from 'react-router-dom';
import { AgentChat } from './components/AgentChat.tsx';
import { WizardProvider } from './context/WizardContext.tsx';
import { ChoosePair } from './pages/ChoosePair.tsx';
import { Connect } from './pages/Connect.tsx';
import { Connectors } from './pages/Connectors.tsx';
import { Explore } from './pages/Explore.tsx';
import { Home } from './pages/Home.tsx';
import { Login } from './pages/Login.tsx';
import { MapUsers } from './pages/MapUsers.tsx';
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
        CloudFuze <span>Studio Migrate</span>
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

/** Dual-panel shell: workflow left, AI chat right (GEM_CO parity). No
 *  progress/step chrome here — each page's own header carries its context,
 *  matching GEM_CO's minimal per-screen header. */
function AppShell() {
  return (
    <WizardProvider>
      <AppHeader />
      <div className="console">
        <div className="pane-workflow">
          <div className="shell">
            <Outlet />
          </div>
        </div>
        <div className="divider" aria-hidden />
        <div className="pane-chat">
          <AgentChat />
        </div>
      </div>
    </WizardProvider>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Login />} />
      <Route element={<AppShell />}>
        <Route path="/home" element={<Home />} />
        <Route path="/pair" element={<ChoosePair />} />
        <Route path="/map-users" element={<MapUsers />} />
        <Route path="/map" element={<SelectMap />} />
        <Route path="/select-data" element={<SelectData />} />
        <Route path="/connect" element={<Connect />} />
        <Route path="/explore" element={<Explore />} />
        <Route path="/connectors" element={<Connectors />} />
        <Route path="/migrate" element={<Migrate />} />
      </Route>
    </Routes>
  );
}
