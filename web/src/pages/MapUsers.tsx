import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  fetchGoogleUsers,
  fetchIdentityMap,
  fetchMsUsers,
  saveIdentityMap,
  type MsUserBrief,
} from '../api.ts';
import { useWizardOptional } from '../context/WizardContext.tsx';
import { avatarColor, IcoDownload, IcoUpload } from '../icons.tsx';

/**
 * Map Users (early) — GEM_CO-style mapping grid.
 * Left: Microsoft Graph users. Right: Google Workspace email (directory + free text).
 * Persist via /api/identity/map. Agent-touched principals refine permissions later.
 * (Per-user agent/chat counts only exist once agents are selected — a later
 * wizard step — so this grid intentionally shows identity only, not usage.)
 */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}
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
  const [googleUsersError, setGoogleUsersError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    setError(null);
    setGoogleUsersError(null);
    try {
      const [ms, map, gResult] = await Promise.all([
        fetchMsUsers(session, { max: 300 }),
        fetchIdentityMap(session).catch(() => ({ tenantId: '', users: {}, groups: {} })),
        fetchGoogleUsers(session, { max: 300 }).catch((e) => ({ users: [], error: (e as Error).message })),
      ]);
      setMsUsers(ms);
      setGoogleUsers(gResult.users);
      if (gResult.error) {
        setGoogleUsersError(
          `Google Workspace directory couldn't be read (${gResult.error}). Check Domain-Wide Delegation ` +
            'includes the admin.directory.* readonly scopes, and that the connected Google account has ' +
            'Workspace admin rights — cloud-platform access alone isn’t enough for this list.',
        );
      }
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
      // Pre-select only users we could actually map. Selecting all 285 tenant users by
      // default made the screen read as "285 of 285 selected · 281 need mapping" — an
      // instruction to hand-map hundreds of accounts that have no Google counterpart and
      // are irrelevant to the agents being migrated. Users can still Select all.
      const mappable = ms.filter((u) => merged[u.email]);
      setSelected(new Set((mappable.length ? mappable : []).map((u) => u.email)));
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
    if (wizard.lastToolEvent?.type === 'clear_mappings') {
      // Clear all 3 layers — React state, the local sessionStorage overlay
      // (which otherwise wins over the server map on next load and makes a
      // "clear" look like it silently undid itself), and the persisted
      // server-side map.
      setUserMap({});
      sessionStorage.removeItem(`csge_usermap_${session}`);
      autoMappedOnce.current = false;
      void saveIdentityMap(session, {}, {}).catch(() => {});
    }
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

  // Paging. A tenant directory is hundreds of rows — rendering them all in one scroll
  // box made the list unusable and slow to render, and made "285 of 285 selected" read
  // as a demand to review every account.
  const PAGE_SIZE = 25;
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  // Snap back to page 1 whenever the filter changes the result set under us.
  useEffect(() => { setPage(0); }, [query]);
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = useMemo(
    () => filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE),
    [filtered, safePage],
  );

  const rowStatus = (email: string): { label: string; cls: string } => {
    const dest = userMap[email]?.trim();
    if (!dest) return { label: 'Unmapped', cls: 'fail' };
    if (dest === email.toLowerCase()) return { label: 'Auto-matched', cls: 'ok' };
    return { label: 'Manual', cls: 'warn' };
  };

  const counts = useMemo(() => {
    let autoMatched = 0;
    let manual = 0;
    let unmapped = 0;
    for (const u of msUsers) {
      const cls = rowStatus(u.email).cls;
      if (cls === 'ok') autoMatched++;
      else if (cls === 'warn') manual++;
      else unmapped++;
    }
    const sel = [...selected].filter((e) => userMap[e]?.trim()).length;
    return {
      total: msUsers.length,
      autoMatched,
      manual,
      unmapped,
      selected: selected.size,
      selectedMapped: sel,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msUsers, userMap, selected]);

  const setDest = (src: string, dest: string) => {
    setUserMap((prev) => {
      const next = { ...prev, [src]: dest.trim().toLowerCase() };
      sessionStorage.setItem(`csge_usermap_${session}`, JSON.stringify(next));
      // Best-effort background save on every edit (GEM_CO-style autosave) —
      // cont() still awaits a final persist() before navigating, so a failed
      // background save here is never the only save attempt.
      void saveIdentityMap(session, next, {}).catch(() => {});
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

  const toggleAll = () => {
    setSelected((prev) => (prev.size === filtered.length ? new Set() : new Set(filtered.map((u) => u.email))));
  };

  const autoMap = async () => {
    const gSet = new Set(googleUsers.map((g) => g.email.toLowerCase()));
    const domains = new Set(
      googleUsers.map((g) => g.email.split('@')[1]?.toLowerCase()).filter(Boolean) as string[],
    );
    const next = { ...userMap };
    let n = 0;
    for (const u of msUsers) {
      const email = u.email.toLowerCase();
      // Exact-match only: the Microsoft email must actually exist as a real
      // Google Workspace account. Domain ownership alone (checked below) is
      // NOT proof this specific address exists — that was the bug that
      // "auto-mapped" 34 users against a directory of only 13 real accounts.
      if (!next[email] && gSet.has(email)) {
        next[email] = email;
        n++;
      }
      // Same local-part match on first owned google domain — still verifies
      // the candidate address actually exists via gSet.has() below.
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
    if (n) void saveIdentityMap(session, next, {}).catch(() => {});
    wizard?.applyUserMapping(next, false);
  };

  // Auto-map runs once, silently, as soon as both directories are loaded —
  // no manual "Auto-map" button. Counts surface via `counts` in the header
  // instead of a status line.
  const autoMappedOnce = useRef(false);
  useEffect(() => {
    if (!loading && msUsers.length && !autoMappedOnce.current) {
      autoMappedOnce.current = true;
      void autoMap();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, msUsers.length]);

  const persist = async () => {
    setSaving(true);
    setError(null);
    try {
      await saveIdentityMap(session, userMap, {});
      sessionStorage.setItem(`csge_usermap_${session}`, JSON.stringify(userMap));
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

  const allSelected = filtered.length > 0 && selected.size === filtered.length;

  return (
    <div className="mu-page">
      <div className="mu-head">
        <div>
          <div className="mu-title">Map Users</div>
          <div className="mu-sub">
            Map Microsoft identities to their Google Workspace destination.{' '}
            {counts.autoMatched > 0 && <span className="mu-ok">{counts.autoMatched} auto-mapped</span>}
            {counts.unmapped > 0 && (
              <span className="mu-fail">
                {counts.autoMatched > 0 ? ' · ' : ''}
                {counts.unmapped} need mapping
              </span>
            )}
          </div>
        </div>
        <div className="mu-actions">
          <label className="mu-iconbtn" title="Import CSV">
            <IcoUpload s={13} />
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
          <button type="button" className="mu-iconbtn primary" title="Export CSV" onClick={exportCsv}>
            <IcoDownload s={13} />
          </button>
        </div>
      </div>

      {loading && (
        <>
          <p className="mu-note" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="cf-spinner" aria-hidden="true" />
            Loading directory… this reads every user in the Microsoft tenant, so it can take a moment.
          </p>
          {/* Skeleton rows: the table rendered empty while loading, which reads as
              "no users found" rather than "still fetching". */}
          <div className="card" style={{ padding: 0, overflow: 'hidden', marginTop: 8 }}>
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div
                key={i}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '10px 14px', borderBottom: '1px solid var(--border)',
                  opacity: 1 - i * 0.13,
                }}
              >
                <div className="cf-skel" style={{ width: 24, height: 24, borderRadius: '50%' }} />
                <div className="cf-skel" style={{ width: '38%', height: 12 }} />
                <div className="cf-skel" style={{ width: '22%', height: 12, marginLeft: 'auto' }} />
              </div>
            ))}
          </div>
        </>
      )}
      {error && <p className="mu-note fail">{error}</p>}
      {googleUsersError && <p className="mu-note fail">{googleUsersError}</p>}
      {status && <p className="mu-note">{status}</p>}

      <div className="mu-selected">
        <strong>{counts.selected}</strong> of {counts.total} selected
      </div>

      <input className="usearch" placeholder="Search by email…" value={query} onChange={(e) => setQuery(e.target.value)} style={{ marginBottom: 12, width: '100%' }} />

      <div className="mu-list">
        <div className="mu-cols">
          <input type="checkbox" checked={allSelected} onChange={toggleAll} />
          <div>Microsoft</div>
          <div>Google Workspace</div>
        </div>
        {pageRows.map((u) => {
          const on = selected.has(u.email);
          const dest = userMap[u.email] || '';
          return (
            <div key={u.id || u.email} className={`mu-row${on ? ' selected' : ''}`} onClick={() => toggleRow(u.email)}>
              <input type="checkbox" checked={on} onChange={() => toggleRow(u.email)} onClick={(e) => e.stopPropagation()} />
              <div className="mu-who">
                <span className="uavatar" style={{ width: 26, height: 26, fontSize: 10, background: avatarColor(u.displayName || u.email) }}>
                  {initials(u.displayName || u.email)}
                </span>
                <span className="mu-email">{u.email}</span>
              </div>
              <div className="mu-dest" onClick={(e) => e.stopPropagation()}>
                {dest ? (
                  <>
                    <span className="uavatar" style={{ width: 22, height: 22, fontSize: 9, background: avatarColor(dest), flexShrink: 0 }}>
                      {initials(dest.split('@')[0])}
                    </span>
                    <span className="mu-email">{dest}</span>
                    <button type="button" className="mdelete" title="Clear mapping" onClick={() => setDest(u.email, '')}>
                      ✕
                    </button>
                  </>
                ) : (
                  <input
                    type="email"
                    list="gusers"
                    placeholder="— assign —"
                    value={dest}
                    onChange={(e) => setDest(u.email, e.target.value)}
                    className="mu-dest-input"
                  />
                )}
              </div>
            </div>
          );
        })}
        {!loading && filtered.length > PAGE_SIZE && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 14px', borderTop: '1px solid var(--border)' }}>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>
              {safePage * PAGE_SIZE + 1}–{Math.min((safePage + 1) * PAGE_SIZE, filtered.length)} of {filtered.length}
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button type="button" className="wbtn" style={{ fontSize: 12, padding: '4px 12px' }}
                disabled={safePage === 0} onClick={() => setPage(0)}>« First</button>
              <button type="button" className="wbtn" style={{ fontSize: 12, padding: '4px 12px' }}
                disabled={safePage === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>‹ Prev</button>
              <span style={{ fontSize: 12, alignSelf: 'center', minWidth: 70, textAlign: 'center' }}>
                Page {safePage + 1} / {pageCount}
              </span>
              <button type="button" className="wbtn" style={{ fontSize: 12, padding: '4px 12px' }}
                disabled={safePage >= pageCount - 1} onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}>Next ›</button>
              <button type="button" className="wbtn" style={{ fontSize: 12, padding: '4px 12px' }}
                disabled={safePage >= pageCount - 1} onClick={() => setPage(pageCount - 1)}>Last »</button>
            </div>
          </div>
        )}
        {!loading && filtered.length === 0 && <div className="mu-empty">No users to show. Connect Microsoft with directory read consent, or continue and map principals after agent selection.</div>}
        <datalist id="gusers">
          {googleUsers.map((g) => (
            <option key={g.email} value={g.email}>
              {g.displayName || g.email}
            </option>
          ))}
        </datalist>
      </div>

      <div className="mu-footer">
        <button type="button" className="wbtn" onClick={() => navigate(`/pair?session=${session}`)}>
          ← Back
        </button>
        <button type="button" className="btn primary" style={{ flex: 1, justifyContent: 'center' }} disabled={saving} onClick={() => void cont()}>
          Continue →
        </button>
      </div>
    </div>
  );
}
