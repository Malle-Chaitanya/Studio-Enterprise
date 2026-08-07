import { useEffect } from 'react';
import { Outlet, Route, Routes, useNavigate, useSearchParams } from 'react-router-dom';
import { fetchSession } from './api.ts';
import { AgentChat } from './components/AgentChat.tsx';
import { WizardProvider } from './context/WizardContext.tsx';
import { ChoosePair } from './pages/ChoosePair.tsx';
import { Connect } from './pages/Connect.tsx';
import { ConnectorConfig } from './pages/ConnectorConfig.tsx';
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
  /**
   * Sign out for real.
   *
   * This used to POST `/api/logout` — an endpoint that does not exist — swallow the
   * 404, and then PUSH `/` onto history. So the session stayed alive, the wizard pages
   * stayed in history, and Back landed on a fully working screen while Forward returned
   * to the login page: the browser arrows bounced between signed-in and signed-out.
   *
   * Three things are needed and all three were missing: end the session server-side,
   * drop the client-side session ids so nothing can be resumed from them, and REPLACE
   * the history entry so Back does not lead back in.
   */
  const signOut = async () => {
    const session = new URLSearchParams(window.location.search).get('session') ?? '';
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session }),
      });
    } catch {
      /* signing out must never strand someone on the page they are leaving */
    }
    // Wizard state is cached per session under csge_* keys — leaving it behind lets a
    // later session pick up the previous user's selections.
    try {
      for (const key of Object.keys(sessionStorage)) {
        if (key.startsWith('csge_')) sessionStorage.removeItem(key);
      }
    } catch {
      /* private mode / storage disabled */
    }
    navigate('/', { replace: true });
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
/**
 * Send someone back to the login page when the session in the URL is gone.
 *
 * After signing out, the browser's Back button still restores a wizard URL carrying
 * `?session=<id>`. The page renders, fires its API calls, and shows a wall of errors
 * instead of saying the obvious thing: you are signed out.
 *
 * Only acts when a session id is PRESENT and rejected. A missing id is left alone —
 * pages reach their own conclusions about that, and redirecting on absence would
 * hijack normal navigation.
 */
function SessionGuard() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const session = params.get('session') ?? '';

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    fetchSession(session)
      .catch(() => {
        if (!cancelled) navigate('/', { replace: true });
      });
    return () => { cancelled = true; };
  }, [session, navigate]);

  return null;
}

function AppShell() {
  return (
    <WizardProvider>
      <SessionGuard />
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
        <Route path="/connector-config" element={<ConnectorConfig />} />
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
