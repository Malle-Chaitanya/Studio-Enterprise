import { useSearchParams } from 'react-router-dom';
import { microsoftStartUrl } from '../api.ts';

export function Landing() {
  const [params] = useSearchParams();
  const error = params.get('error');

  return (
    <div className="card">
      <div className="logo">
        Cloud<span>Fuze</span>
      </div>
      <div className="pill">● Studio Migrate — Agents</div>

      {error && <div className="error">Error: {error}</div>}

      <h2>Migrate agents from Copilot Studio to Gemini Enterprise</h2>
      <p className="lead">
        Connect your Microsoft and Google accounts. Agents are extracted from Copilot Studio,
        faithfully mapped, and deployed into Gemini Enterprise — with a fidelity report for each one.
      </p>

      <div className="steps">
        <div className="step">
          <div className="num active">1</div>
          <div>
            <strong>Connect Microsoft</strong> — extract agents from Copilot Studio
          </div>
        </div>
        <div className="step">
          <div className="num todo">2</div>
          <div>Connect Google — identify your Gemini Enterprise account</div>
        </div>
        <div className="step">
          <div className="num todo">3</div>
          <div>Migrate — create, deploy, verify, and report</div>
        </div>
      </div>

      <a className="btn ms" href={microsoftStartUrl()}>
        Connect Microsoft
      </a>
    </div>
  );
}
