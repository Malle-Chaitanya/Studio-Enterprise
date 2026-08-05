import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  fetchGoogleUsers,
  fetchIdentityMap,
  fetchMsUsers,
  saveIdentityMap,
  type MsUserBrief,
} from '../api.ts';
import { useWizardOptional } from '../context/WizardContext.tsx';

/**
 * Map Users (early) — GEM_CO-style mapping grid.
 * Left: Microsoft Graph users. Right: Google Workspace email (directory + free text).
 * Persist via /api/identity/map. Agent-touched principals refine permissions later.
 */
export function MapUsers() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const session = params.get('session') ?? '';
  const wizard = useWizardOptional();

  const [msUsers, setMsUsers] = useState<MsUserBrief[]>([]);
  const [googleUsers, setGoogleUsers] = useState<{ email: string; displayName?: string }[]>([]);
  const [userMap, setUserMap] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const [ownedHint, setOwnedHint] = useState<string[]>([]);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    setError(null);
    try {
      const [ms, map, gUsers] = await Promise.all([
        fetchMsUsers(session, { max: 300 }),
        fetchIdentityMap(session).catch(() => ({ tenantId: '', users: {}, groups: {} })),
        fetchGoogleUsers(session, { max: 300 }).catch(() => []),
      ]);
      setMsUsers(ms);
      setGoogleUsers(gUsers);
      // Merge server map + any chat-applied sessionStorage overlay
      let overlay: Record<string, string> = {};
      try {
        overlay = JSON.parse(sessionStorage.getItem(`csge_usermap_${session}`) || '{}');
      } catch {
        overlay = {};
      }
      const merged = { ...(map.users ?? {}), ...overlay };
      setUserMap(merged);
      sessionStorage.setItem(`csge_usermap_${session}`, JSON.stringify(merged));
      setSelected(new Set(ms.map((u) => u.email)));
      if (!ms.length) {
        setStatus('No Microsoft users returned — check Graph User.Read.All consent, or type emails manually after adding rows.');
      }
    } catch (e) {
      setError((e as Error).message || 'Failed to load users');
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!wizard) return;
    return wizard.onMappingPatch((users) => {
      setUserMap(users);
    });
  }, [wizard]);

  useEffect(() => {
    if (!wizard) return;
    // Reload when chat bumps tool epoch with mapping events
    if (wizard.lastToolEvent?.type === 'auto_map_users' || wizard.lastToolEvent?.type === 'set_user_mapping') {
      const users = (wizard.lastToolEvent.users as Record<string, string>) || userMap;
      if (wizard.lastToolEvent.type === 'set_user_mapping' && wizard.lastToolEvent.sourceEmail) {
        setUserMap((prev) => ({
          ...prev,
          [String(wizard.lastToolEvent!.sourceEmail)]: String(wizard.lastToolEvent!.destEmail),
        }));
      } else if (users && typeof users === 'object') {
        setUserMap((prev) => ({ ...prev, ...users }));
      }
    }
    if (wizard.lastToolEvent?.type === 'clear_mappings') setUserMap({});
  }, [wizard?.toolEpoch]); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return msUsers;
    return msUsers.filter(
      (u) =>
        u.email.includes(q) ||
        (u.displayName || '').toLowerCase().includes(q) ||
        (userMap[u.email] || '').toLowerCase().includes(q),
    );
  }, [msUsers, query, userMap]);

  const counts = useMemo(() => {
    const mapped = Object.entries(userMap).filter(([, v]) => v?.trim()).length;
    const sel = [...selected].filter((e) => userMap[e]?.trim()).length;
    return { total: msUsers.length, mapped, selected: selected.size, selectedMapped: sel };
  }, [msUsers, userMap, selected]);

  const setDest = (src: string, dest: string) => {
    setUserMap((prev) => {
      const next = { ...prev, [src]: dest.trim().toLowerCase() };
      sessionStorage.setItem(`csge_usermap_${session}`, JSON.stringify(next));
      return next;
    });
  };

  const toggleRow = (email: string) => {
    setSelected((prev) => {
      const n = new Set(prev);
      n.has(email) ? n.delete(email) : n.add(email);
      return n;
    });
  };

  const selectAll = () => setSelected(new Set(filtered.map((u) => u.email)));
  const deselectAll = () => setSelected(new Set());

  const autoMap = async () => {
    setStatus('Auto-mapping by email…');
    const gSet = new Set(googleUsers.map((g) => g.email.toLowerCase()));
    const domains = new Set(
      googleUsers.map((g) => g.email.split('@')[1]?.toLowerCase()).filter(Boolean) as string[],
    );
    setOwnedHint([...domains]);
    const next = { ...userMap };
    let n = 0;
    for (const u of msUsers) {
      const email = u.email.toLowerCase();
      const domain = email.split('@')[1];
      if (gSet.has(email) || domains.has(domain)) {
        if (!next[email]) {
          next[email] = email;
          n++;
        } else if (!next[email] && gSet.has(email)) {
          next[email] = email;
          n++;
        }
      }
      // Same local-part match on first owned google domain
      if (!next[email] && domains.size) {
        const local = email.split('@')[0];
        for (const d of domains) {
          const candidate = `${local}@${d}`;
          if (gSet.has(candidate)) {
            next[email] = candidate;
            n++;
            break;
          }
        }
      }
    }
    setUserMap(next);
    sessionStorage.setItem(`csge_usermap_${session}`, JSON.stringify(next));
    setStatus(`Auto-mapped ${n} user(s). Review before continuing.`);
    wizard?.applyUserMapping(next, false);
  };

  const persist = async () => {
    setSaving(true);
    setError(null);
    try {
      await saveIdentityMap(session, userMap, {});
      sessionStorage.setItem(`csge_usermap_${session}`, JSON.stringify(userMap));
      setStatus('Mappings saved.');
    } catch (e) {
      setError((e as Error).message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const exportCsv = () => {
    const lines = ['source_email,destination_email,selected'];
    for (const u of msUsers) {
      lines.push(`"${u.email}","${userMap[u.email] || ''}","${selected.has(u.email) ? '1' : '0'}"`);
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'csge-user-map.csv';
    a.click();
  };

  const importCsv = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || '');
      const next = { ...userMap };
      for (const line of text.split(/\r?\n/).slice(1)) {
        const m = line.match(/"([^"]*)","([^"]*)"/) || line.split(',');
        const src = (Array.isArray(m) ? m[1] || m[0] : '').replace(/"/g, '').trim().toLowerCase();
        const dest = (Array.isArray(m) ? m[2] || m[1] : '').replace(/"/g, '').trim().toLowerCase();
        if (src && src.includes('@')) next[src] = dest;
      }
      setUserMap(next);
      sessionStorage.setItem(`csge_usermap_${session}`, JSON.stringify(next));
      setStatus('CSV imported.');
    };
    reader.readAsText(file);
  };

  const cont = async () => {
    await persist();
    navigate(`/map?session=${session}`);
  };

  return (
    <div className="card wide" style={{ maxWidth: 960 }}>
      <h2>Map Users</h2>
      <p className="lead">
        Map Microsoft identities to Google Workspace emails early. After you select agents,
        permissions still use agent-touched principals + this map — we never silently over-share.
      </p>

      {loading && <p className="lead">Loading directory…</p>}
      {error && <p className="error">{error}</p>}
      {status && <p className="lead">{status}</p>}

      <div className="map-counts">
        <span>
          Users <strong>{counts.total}</strong>
        </span>
        <span>
          Mapped <strong>{counts.mapped}</strong>
        </span>
        <span>
          Selected <strong>{counts.selected}</strong>
        </span>
        {ownedHint.length > 0 && (
          <span>
            Domains <strong>{ownedHint.join(', ')}</strong>
          </span>
        )}
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
        <div className="usearch-wrap" style={{ flex: 1, minWidth: 180 }}>
          <input
            className="usearch"
            placeholder="Search users…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <button type="button" className="wbtn" onClick={() => void autoMap()}>
          Auto-map
        </button>
        <button type="button" className="wbtn" onClick={selectAll}>
          Select all
        </button>
        <button type="button" className="wbtn" onClick={deselectAll}>
          Deselect
        </button>
        <button type="button" className="wbtn" onClick={exportCsv}>
          Export CSV
        </button>
        <label className="wbtn" style={{ cursor: 'pointer' }}>
          Import CSV
          <input
            type="file"
            accept=".csv,text/csv"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importCsv(f);
            }}
          />
        </label>
        <button type="button" className="wbtn" disabled={saving} onClick={() => void persist()}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      <div style={{ maxHeight: 420, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
        <table className="mapgrid">
          <thead>
            <tr>
              <th style={{ width: 36 }} />
              <th>Microsoft (source)</th>
              <th>Google Workspace (destination)</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((u) => {
              const on = selected.has(u.email);
              return (
                <tr key={u.id || u.email} className={on ? 'selected' : ''}>
                  <td>
                    <input type="checkbox" checked={on} onChange={() => toggleRow(u.email)} />
                  </td>
                  <td>
                    <div style={{ fontWeight: 500 }}>{u.displayName || u.email}</div>
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>{u.email}</div>
                  </td>
                  <td>
                    <input
                      type="email"
                      list="gusers"
                      placeholder="user@workspace.com"
                      value={userMap[u.email] || ''}
                      onChange={(e) => setDest(u.email, e.target.value)}
                    />
                  </td>
                </tr>
              );
            })}
            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={3} style={{ padding: 20, color: 'var(--muted)' }}>
                  No users to show. Connect Microsoft with directory read consent, or continue and map
                  principals after agent selection.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <datalist id="gusers">
          {googleUsers.map((g) => (
            <option key={g.email} value={g.email}>
              {g.displayName || g.email}
            </option>
          ))}
        </datalist>
      </div>

      <div className="wizard-actions" style={{ marginTop: 20 }}>
        <button type="button" className="wbtn" onClick={() => navigate(`/pair?session=${session}`)}>
          ← Back
        </button>
        <button type="button" className="btn primary" onClick={() => void cont()}>
          Continue to Environments →
        </button>
      </div>
    </div>
  );
}
