import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { fetchAgents, fetchEnvironments, fetchIdentityMap } from '../api.ts';
import { useWizardOptional } from '../context/WizardContext.tsx';
import { avatarColor } from '../icons.tsx';
import type { AgentBrief, EnvironmentInfo } from '../types.ts';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (name.slice(0, 2) || '?').toUpperCase();
}

/**
 * Select Agents — after Map Users + environment map. Shows owner + access when
 * available; optional filter by mapped owner email.
 */
export function SelectData() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const session = params.get('session') ?? '';
  const wizard = useWizardOptional();

  const [envs, setEnvs] = useState<EnvironmentInfo[]>([]);
  const [agentsByEnv, setAgentsByEnv] = useState<Record<string, AgentBrief[]>>({});
  const [selected, setSelected] = useState<Record<string, Set<string>>>({});
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [ownerFilter, setOwnerFilter] = useState('');
  const [mappedEmails, setMappedEmails] = useState<string[]>([]);

  useEffect(() => {
    if (!session) return;
    (async () => {
      let chosen: { env: string; name: string }[] = [];
      try {
        chosen = JSON.parse(sessionStorage.getItem(`csge_envs_${session}`) || '[]');
      } catch {
        /* none */
      }
      let acc: EnvironmentInfo[];
      if (chosen.length) {
        const all = await fetchEnvironments(session).catch(() => []);
        const byUrl = new Map(all.map((e) => [e.url, e]));
        acc = chosen.map(
          (c) =>
            byUrl.get(c.env) ??
            ({ url: c.env, name: c.name, accessible: true, bots: 0, knowledgeSources: 0, flows: 0 } as EnvironmentInfo),
        );
      } else {
        acc = (await fetchEnvironments(session).catch(() => [])).filter((e) => e.accessible);
      }
      setEnvs(acc);
      const map: Record<string, AgentBrief[]> = {};
      const sel: Record<string, Set<string>> = {};
      for (const e of acc) {
        const ags = await fetchAgents(session, e.url).catch(() => []);
        map[e.url] = ags;
        sel[e.url] = new Set(ags.map((a) => a.botid));
      }
      setAgentsByEnv(map);
      setSelected(sel);
      try {
        const idMap = await fetchIdentityMap(session);
        setMappedEmails(Object.keys(idMap.users ?? {}).filter((k) => idMap.users[k]));
      } catch {
        /* optional */
      }
      setLoading(false);
    })();
  }, [session, wizard?.toolEpoch]);

  const toggle = (env: string, botId: string) =>
    setSelected((prev) => {
      const s = new Set(prev[env]);
      s.has(botId) ? s.delete(botId) : s.add(botId);
      return { ...prev, [env]: s };
    });
  const selectAll = (env: string) =>
    setSelected((prev) => ({ ...prev, [env]: new Set((agentsByEnv[env] ?? []).map((a) => a.botid)) }));
  const deselectAll = (env: string) => setSelected((prev) => ({ ...prev, [env]: new Set() }));

  const totalSelected = useMemo(
    () => Object.values(selected).reduce((n, s) => n + s.size, 0),
    [selected],
  );

  const cont = () => {
    const payload = envs
      .map((e) => ({ env: e.url, name: e.name, botIds: [...(selected[e.url] ?? [])] }))
      .filter((u) => u.botIds.length);
    sessionStorage.setItem(`csge_data_${session}`, JSON.stringify(payload));
    wizard?.setAgentSelection(payload);
    navigate(`/connector-config?session=${session}`);
  };

  const match = (a: AgentBrief) => {
    const q = query.toLowerCase().trim();
    if (q && !a.name.toLowerCase().includes(q) && !(a.ownerEmail || '').toLowerCase().includes(q)) {
      return false;
    }
    if (ownerFilter) {
      const oe = (a.ownerEmail || '').toLowerCase();
      if (ownerFilter === '__unmapped__') return !oe || !mappedEmails.includes(oe);
      return oe === ownerFilter.toLowerCase();
    }
    return true;
  };

  return (
    <div className="card wide">
      <h2>Select Agents</h2>
      <p className="lead">
        Choose which agents to migrate. Owner and access are shown when Dataverse returns them.
        Personal/private agents stay selectable.
      </p>

      {loading && <p className="lead">Loading agents…</p>}

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <div className="usearch-wrap" style={{ flex: 1, minWidth: 180 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#9aa0a6" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            className="usearch"
            placeholder="Search agents or owners…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <select
          className="usearch"
          style={{ maxWidth: 260 }}
          value={ownerFilter}
          onChange={(e) => setOwnerFilter(e.target.value)}
          aria-label="Filter by mapped owner"
        >
          <option value="">All owners</option>
          <option value="__unmapped__">Unmapped / unknown owner</option>
          {mappedEmails.map((e) => (
            <option key={e} value={e}>
              Mapped: {e}
            </option>
          ))}
        </select>
      </div>

      {envs.map((e) => {
        const agents = (agentsByEnv[e.url] ?? []).filter(match);
        const sel = selected[e.url] ?? new Set<string>();
        const total = agentsByEnv[e.url]?.length ?? 0;
        return (
          <div key={e.url} style={{ marginBottom: 24 }}>
            <div className="dlist-head">
              <span className="signed">
                <span className="dot" />
                {e.name} · {sel.size} of {total} agents
              </span>
              <span style={{ display: 'flex', gap: 16 }}>
                <button type="button" className="dlink" onClick={() => selectAll(e.url)}>
                  Select All
                </button>
                <button type="button" className="dlink" onClick={() => deselectAll(e.url)}>
                  Deselect All
                </button>
              </span>
            </div>
            {agents.map((a) => {
              const on = sel.has(a.botid);
              const access = a.accessLabel || 'Unknown';
              const accessClass =
                access === 'Org-wide' ? 'org' : access === 'Private' ? 'private' : '';
              return (
                <label key={a.botid} className={`urow ${on ? 'on' : ''}`}>
                  <input type="checkbox" checked={on} onChange={() => toggle(e.url, a.botid)} />
                  <span className="uavatar" style={{ background: avatarColor(a.name) }}>
                    {initials(a.name)}
                  </span>
                  <span className="uinfo" style={{ flex: 1 }}>
                    <span className="uname">
                      {a.name}
                      {access === 'Private' && <span className="badge-owner">personal</span>}
                    </span>
                    <span className="usub">
                      {a.ownerDisplayName || a.ownerEmail || 'Owner unknown'}
                      {a.ownerEmail && a.ownerDisplayName ? ` · ${a.ownerEmail}` : ''}
                      {' · '}
                      {e.name}
                    </span>
                  </span>
                  <span className={`access-pill ${accessClass}`}>{access}</span>
                  {on && <span className="ucheck">✓</span>}
                </label>
              );
            })}
          </div>
        );
      })}

      <button type="button" className="btn primary" style={{ marginTop: 8 }} disabled={totalSelected === 0} onClick={cont}>
        Continue with {totalSelected} agent{totalSelected === 1 ? '' : 's'} →
      </button>
      <button type="button" className="wbtn" style={{ marginTop: 12 }} onClick={() => navigate(`/map?session=${session}`)}>
        ← Back
      </button>
      <button
        type="button"
        className="wbtn"
        style={{ marginTop: 8, marginLeft: 8 }}
        disabled={totalSelected === 0}
        onClick={() => {
          const payload = envs
            .map((e) => ({ env: e.url, name: e.name, botIds: [...(selected[e.url] ?? [])] }))
            .filter((u) => u.botIds.length);
          sessionStorage.setItem(`csge_data_${session}`, JSON.stringify(payload));
          navigate(`/migrate?session=${session}`);
        }}
      >
        Skip connectors → Migrate
      </button>
    </div>
  );
}
