import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { initialAgentState, reduceAgent } from '../../agent/driver.ts';
import { V2Layout } from '../../components/v2/V2Layout.tsx';
import {
  Band, BandCell, Btn, Chip, Inspector, InspectorHead, InspectorSection, KeyValue, Note,
  NoteRow, Panel, PanelHead, Row, WizardFooter, type ChipTone,
} from '../../components/v2/primitives.tsx';
import { useSource, type ReportRow, type Verdict } from '../../v2/data/index.ts';

const VERDICT_CHIP: Record<Verdict, ChipTone> = { clean: 'ok', 'needs-review': 'you', lost: 'bad' };

/**
 * Fidelity report.
 *
 * The honest account of a run: what was created, what was verified, and what was
 * lost. "Verified" here means a smoke test actually answered — an unverified agent
 * is reported as unverified, never as a success, because the reader's next action
 * differs.
 */
export default function ReportV2() {
  const [params] = useSearchParams();
  const session = params.get('session') ?? '';
  const navigate = useNavigate();
  const source = useSource();

  const [rows, setRows] = useState<ReportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [agent, dispatch] = useReducer(reduceAgent, initialAgentState);

  const load = useCallback(async (): Promise<void> => {
    if (!session) { setLoading(false); setError('no_session'); return; }
    setLoading(true);
    try {
      setRows(await source.report.list(session));
      setError('');
    } catch (e) {
      setError((e as Error).message || 'report_failed');
    } finally {
      setLoading(false);
    }
  }, [session, source]);

  useEffect(() => { void load(); }, [load]);

  const totals = rows.reduce<Record<Verdict, number>>(
    (acc, r) => ({
      clean: acc.clean + r.counts.clean,
      'needs-review': acc['needs-review'] + r.counts['needs-review'],
      lost: acc.lost + r.counts.lost,
    }),
    { clean: 0, 'needs-review': 0, lost: 0 },
  );
  const verified = rows.filter((r) => r.verified).length;
  const selected = useMemo(() => rows.find((r) => r.name === picked) ?? rows[0] ?? null, [rows, picked]);

  const download = (): void => {
    // Built in the browser from what is on screen, so the file and the screen can
    // never disagree.
    const blob = new Blob([JSON.stringify({ session, generated: new Date().toISOString(), agents: rows }, null, 2)],
      { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fidelity-report-${session}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const canvas = (
    <>
      <Panel>
        <Band>
          <BandCell label="Migrated" value={rows.length || '—'} note="agents in Gemini" tone="ok" />
          <BandCell label="Verified" value={rows.length ? `${verified}/${rows.length}` : '—'}
            note="answered a smoke test" tone={verified === rows.length && rows.length ? 'ok' : 'amber'} />
          <BandCell label="Needs review" value={totals['needs-review'] || '—'} note="check these"
            tone={totals['needs-review'] ? 'amber' : 'plain'} />
          <BandCell label="Lost" value={totals.lost || '—'} note="did not come across"
            tone={totals.lost ? 'bad' : 'plain'} />
        </Band>
      </Panel>

      <Panel>
        <PanelHead
          title="Fidelity report"
          sub="Per agent, what came across and what did not. The same findings you saw before the run, now with the outcome attached."
          actions={
            <>
              <Btn onClick={() => void load()} disabled={loading}>{loading ? 'Reading…' : 'Refresh'}</Btn>
              <Btn tone="blue" onClick={download} disabled={rows.length === 0}>Download JSON</Btn>
            </>
          }
        />

        {error && (
          <NoteRow tone="bad">
            {error === 'no_session' ? 'No connected session.' : `Could not read the report: ${error}`}
          </NoteRow>
        )}

        {!loading && !error && rows.length === 0 && (
          <NoteRow>
            No run to report on in this session. Past runs are stored server-side, but there is
            no endpoint to read them back yet — so this screen will not invent a history.
          </NoteRow>
        )}

        {rows.map((r) => {
          const worst: Verdict = r.counts.lost ? 'lost' : r.counts['needs-review'] ? 'needs-review' : 'clean';
          return (
            <Row
              key={r.name}
              glyph={r.name.slice(0, 2).toUpperCase()}
              name={r.name}
              sub={r.env.replace('https://', '')}
              why={r.findings.find((f) => f.verdict === 'lost')?.detail
                ?? r.findings.find((f) => f.verdict === 'needs-review')?.detail
                ?? 'Everything came across'}
              selected={selected?.name === r.name}
              onSelect={() => setPicked(r.name)}
              status={<Chip tone={VERDICT_CHIP[worst]}>
                {worst === 'lost' ? `${r.counts.lost} lost` : worst === 'needs-review' ? `${r.counts['needs-review']} to check` : 'full fidelity'}
              </Chip>}
              action={r.verified
                ? <Chip tone="ok">verified</Chip>
                : <Chip tone="warn">not verified</Chip>}
            />
          );
        })}
      </Panel>

      <WizardFooter
        onBack={() => navigate(`/v2/migrate?${params.toString()}`)}
        nextLabel="Start another migration"
        onNext={() => navigate(`/v2/select-agents?${params.toString()}`)}
        note={rows.length
          ? totals.lost
            ? `${totals.lost} behaviour${totals.lost > 1 ? 's' : ''} did not come across — those are listed per agent`
            : 'Nothing was lost in this run'
          : 'Nothing to report yet'}
      />
    </>
  );

  const inspector = (
    <Inspector>
      {selected ? (
        <>
          <InspectorHead
            kind="Migrated agent"
            title={selected.name}
            status={selected.verified ? <Chip tone="ok">verified</Chip> : <Chip tone="warn">not verified</Chip>}
          />
          <InspectorSection title="Outcome">
            <dl>
              <KeyValue k="Created" v={selected.ok ? 'yes' : 'no'} />
              <KeyValue k="Verified" v={selected.verified ? 'yes' : 'no — check still owed'} />
              <KeyValue k="Clean" v={selected.counts.clean} />
              <KeyValue k="Needs review" v={selected.counts['needs-review']} />
              <KeyValue k="Lost" v={selected.counts.lost} />
            </dl>
          </InspectorSection>
          <InspectorSection title={`Findings (${selected.findings.length})`}>
            {selected.findings.map((f, i) => (
              <Note key={`${i}-${f.component}`}
                tone={f.verdict === 'lost' ? 'bad' : f.verdict === 'needs-review' ? 'you' : 'ok'}>
                <b>{f.component}</b> — {f.detail}
              </Note>
            ))}
          </InspectorSection>
          {!selected.verified && (
            <InspectorSection title="Why not verified">
              <Note tone="you">
                No smoke test confirmed this agent answers. That is a check still owed, not a
                failure — open it in Gemini and ask it something.
              </Note>
            </InspectorSection>
          )}
        </>
      ) : (
        <InspectorHead kind="Migrated agent" title={loading ? 'Reading…' : 'Nothing to show'} />
      )}
    </Inspector>
  );

  return (
    <V2Layout
      phase="report"
      phaseStatus={{
        connect: { state: 'done' },
        'pair-envs': { state: 'done' },
        'map-users': { state: 'done' },
        'select-agents': { state: 'done' },
        review: { state: 'done' },
        connectors: { state: 'done' },
        migrate: { state: 'done' },
        report: { state: 'current', count: rows.length || undefined },
      }}
      agent={agent}
      manual
      suggestions={[]}
      onPrompt={() => undefined}
      onStop={() => dispatch({ kind: 'idle' })}
      canvas={canvas}
      inspector={inspector}
    />
  );
}
