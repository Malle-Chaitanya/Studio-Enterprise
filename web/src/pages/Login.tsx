import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { resumeSession } from '../api.ts';

const CHECK = (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

/**
 * Sign-in screen — matches GEM_CO's split-screen login exactly (deep-blue left
 * panel + white card on the right), copy adapted to Copilot Studio → Gemini.
 *
 * This used to be a doorway with no lock: it POSTed to `/api/login`, which did not exist,
 * and treated everything except a 401 as success — so any input signed you in. Now only a
 * 2xx proceeds, and the httpOnly cookie the server sets is what every later request is
 * authorized by.
 */
export function Login() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The server answers with an httpOnly session cookie; without credentials the
        // browser would drop it and every later request would be anonymous.
        credentials: 'include',
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        const sid = await resumeSession();
        // v2 is the product now. The old wizard stays REACHABLE at /home and its
        // other routes — nothing is deleted while Migrate and Report are still
        // being compared against it — but it is no longer where signing in lands.
        navigate(sid ? `/v2/connect?session=${sid}` : '/v2/connect');
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
      // Distinguish "wrong password" from "the accounts database is down" — telling an
      // operator their credentials are wrong when the server cannot check them sends them
      // hunting for the wrong problem.
      setError(
        res.status === 503
          ? data.detail || 'Sign-in is temporarily unavailable. Try again shortly.'
          : 'Invalid email or password.',
      );
    } catch {
      setError('Could not reach the server. Check it is running and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="login-left">
        <div className="login-logo">
          <img src="/assets/logo.png" alt="CloudFuze" style={{ height: 48, objectFit: 'contain' }} />
          <div className="login-logo-divider" />
          <span className="login-logo-text">CloudFuze AI Migrations</span>
        </div>
        <div className="login-content">
          <div className="login-tag">Enterprise AI Agent Migration</div>
          <div className="login-title">
            Move your agents to Gemini Enterprise
            <br />
            <span>without losing how they work.</span>
          </div>
          <div className="login-desc">
            CloudFuze moves your agents from Microsoft Copilot Studio to Google Gemini
            Enterprise automatically, so you don't have to rebuild them by hand.
          </div>
          <div className="login-bullets">
            <div className="login-bullet">
              <div className="login-bullet-icon">{CHECK}</div>
              Every agent, topic, and knowledge source moves automatically
            </div>
            <div className="login-bullet">
              <div className="login-bullet-icon">{CHECK}</div>
              Instructions and behavior carry over as-is, not rebuilt from scratch
            </div>
            <div className="login-bullet">
              <div className="login-bullet-icon">{CHECK}</div>
              A clear report for every agent — what moved cleanly, what needs a look
            </div>
          </div>
        </div>
        <div className="login-footer">
          <span>CloudFuze © 2026. All rights reserved.</span>
          <a href="https://www.cloudfuze.com/terms-of-use/" target="_blank" rel="noopener noreferrer">Terms of Use</a>
          <span aria-hidden="true">|</span>
          <a href="https://www.cloudfuze.com/privacy-policy/" target="_blank" rel="noopener noreferrer">Privacy Policy</a>
          <span aria-hidden="true">|</span>
          <span>Help</span>
        </div>
      </div>

      <div className="login-right">
        <div className="login-card">
          <div className="login-card-logo">
            <img src="/assets/CloudFuze blue.png" alt="CloudFuze" style={{ height: 68, objectFit: 'contain' }} />
          </div>
          <div className="login-card-title">Welcome back</div>
          <div className="login-card-sub">Sign in to access the migration tool</div>

          {error && (
            <div className="cf-alert cf-alert--danger" style={{ marginBottom: 16 }} role="alert">
              <div className="cf-alert__desc">{error}</div>
            </div>
          )}

          <form onSubmit={submit}>
            <div className="cf-field">
              <label className="cf-label" htmlFor="login-email">Email</label>
              <input
                className="cf-input"
                id="login-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                autoComplete="username"
                required
              />
            </div>
            <div className="cf-field">
              <label className="cf-label" htmlFor="login-password">Password</label>
              <input
                className="cf-input"
                id="login-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
                required
              />
            </div>
            <button
              type="submit"
              className="cf-btn cf-btn--primary"
              style={{ width: '100%', justifyContent: 'space-between', borderRadius: 10, padding: '14px 20px' }}
              disabled={busy}
            >
              {busy ? 'Signing in…' : 'Sign In'}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
