import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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

/**
 * Searchable destination-user combobox — replaces a native <input list=…> +
 * <datalist>, which renders as the browser's own unstyled autofill-suggestion
 * list (that's the "looks like saved users" complaint: it's not our UI at all,
 * it's the browser's). Still free-text (an admin can type an email that isn't
 * in the directory yet), but now filters as you type and shows avatar + name.
 *
 * The menu is a fixed-position react-dom portal into <body>, not an in-flow
 * absolutely-positioned child — .mu-list scrolls (overflow-y: auto), and an
 * absolute child gets clipped by that ancestor's overflow the moment a row
 * near the bottom opens its dropdown. A portal sidesteps that entirely.
 */
function GoogleUserCombobox({
  value,
  users,
  onChange,
}: {
  value: string;
  users: { email: string; displayName?: string }[];
  onChange: (email: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(value);
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => setText(value), [value]);

  const placeMenu = () => {
    const r = inputRef.current?.getBoundingClientRect();
    if (r) setRect({ top: r.bottom + 4, left: r.left, width: r.width });
  };

  useEffect(() => {
    if (!open) return;
    placeMenu();
    const onDocMouseDown = (e: MouseEvent) => {
      if (inputRef.current?.contains(e.target as Node)) return;
      if (menuRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    window.addEventListener('scroll', placeMenu, true);
    window.addEventListener('resize', placeMenu);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      window.removeEventListener('scroll', placeMenu, true);
      window.removeEventListener('resize', placeMenu);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // No cap here — the menu itself scrolls (max-height + overflow-y: auto in CSS).
  // An earlier .slice(0, 8) truncated the UNFILTERED list before the scroll ever
  // came into play, so a user near the end alphabetically (e.g. "zara") was simply
  // never rendered, no matter how far you scrolled the dropdown. googleUsers is
  // already bounded by the fetch (max: 300), so rendering all matches is cheap.
  const q = text.toLowerCase().trim();
  const matches = q
    ? users.filter((u) => u.email.toLowerCase().includes(q) || (u.displayName || '').toLowerCase().includes(q))
    : users;

  const pick = (email: string) => {
    setText(email);
    onChange(email);
    setOpen(false);
  };

  return (
    <>
      <input
        ref={inputRef}
        type="text"
        placeholder="— assign —"
        className="mu-dest-input"
        value={text}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setText(e.target.value);
          onChange(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
          if (e.key === 'Enter') setOpen(false);
        }}
      />
      {open &&
        matches.length > 0 &&
        rect &&
        createPortal(
          <div
            ref={menuRef}
            className="mu-combobox-menu"
            style={{ position: 'fixed', top: rect.top, left: rect.left, width: Math.max(rect.width, 240) }}
          >
            {matches.map((u) => (
              <div key={u.email} className="mu-combobox-opt" onMouseDown={(e) => { e.preventDefault(); pick(u.email); }}>
                <span
                  className="uavatar"
                  style={{ width: 20, height: 20, fontSize: 8, background: avatarColor(u.displayName || u.email), flexShrink: 0 }}
                >
                  {initials(u.displayName || u.email)}
                </span>
                <div className="mu-combobox-opt-text">
                  <div className="mu-combobox-opt-email">{u.email}</div>
                  {u.displayName && <div className="mu-combobox-opt-name">{u.displayName}</div>}
                </div>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
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
          <div className="mu-sub">Map Microsoft identities to their Google Workspace destination.</div>
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
        <p className="mu-note" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="cf-spinner" aria-hidden="true" />
          Loading directory… this reads every user in the Microsoft tenant, so it can take a moment.
        </p>
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
        {loading &&
          [42, 34, 40, 30, 36, 32].map((nameWidth, i) => (
            <div key={i} className="mu-row">
              <div className="cf-skel" style={{ width: 16, height: 16, borderRadius: 4 }} />
              <div className="mu-who">
                <span className="cf-skel" style={{ width: 26, height: 26, borderRadius: '50%' }} />
                <span className="cf-skel" style={{ width: `${nameWidth}%`, height: 12 }} />
              </div>
              <div className="mu-dest">
                <span className="cf-skel" style={{ width: 22, height: 22, borderRadius: '50%' }} />
                <span className="cf-skel" style={{ width: '45%', height: 12 }} />
              </div>
            </div>
          ))}
        {!loading && filtered.map((u) => {
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
                    <button
                      type="button"
                      className="mdelete"
                      title="Clear mapping"
                      onClick={() => {
                        setDest(u.email, '');
                        wizard?.notifyAction(`Cleared the mapping for ${u.email}`);
                      }}
                    >
                      ✕
                    </button>
                  </>
                ) : (
                  <GoogleUserCombobox value={dest} users={googleUsers} onChange={(email) => setDest(u.email, email)} />
                )}
              </div>
            </div>
          );
        })}
        {!loading && filtered.length === 0 && <div className="mu-empty">No users to show. Connect Microsoft with directory read consent, or continue and map principals after agent selection.</div>}
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
