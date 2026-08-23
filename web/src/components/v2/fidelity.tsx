import { useEffect, useState } from 'react';
import { KeyValue, Note, NoteRow, Panel, PanelHead } from './primitives.tsx';
import {
  useSource, type AgentRow, type ReviewRow, type Verdict,
} from '../../v2/data/index.ts';

/**
 * The fidelity assessment, shared by whichever screen sits last before the run.
 *
 * It was a phase ("Review what changes"), then a panel on Connectors, and now it
 * follows the run because Connectors is opened on demand rather than walked. What
 * has never changed is the requirement behind it: the customer sees what will be
 * lost while they can still decide not to. Once the agents are in Gemini this is
 * a report, not a decision.
 *
 * The assessment deliberately does NOT move the agent cursor. It is a background
 * read nobody asked for, so it has not earned the amber state.
 */
export interface Fidelity {
  agents: AgentRow[];
  reviews: Record<string, ReviewRow>;
  state: 'idle' | 'reading' | 'done' | 'failed';
  /** Agents whose assessment call failed: unknown, never clean. */
  unknown: string[];
  totals: Record<Verdict, number>;
  lossy: ReviewRow[];
  /** Which agent is being assessed right now, 1-based, and its name. Each call
   *  takes 3-8 seconds against a real tenant, so a single indefinite line is
   *  indistinguishable from a hang — the count has to move. */
  progress?: { done: number; total: number; name: string };
}

export function useFidelity(session: string): Fidelity {
  const source = useSource();
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [reviews, setReviews] = useState<Record<string, ReviewRow>>({});
  const [state, setState] = useState<Fidelity['state']>('idle');
  const [unknown, setUnknown] = useState<string[]>([]);
  const [progress, setProgress] = useState<Fidelity['progress']>(undefined);

  useEffect(() => {
    if (!session) return;
    let live = true;
    void (async () => {
      setState('reading');
      let list: AgentRow[] = [];
      try {
        const selection: Array<{ env: string; botIds: string[] }> =
          JSON.parse(sessionStorage.getItem(`csge_data_${session}`) || '[]');
        const all = await source.agents.list(session, selection.map((s) => s.env));
        const ids = new Set(selection.flatMap((s) => s.botIds));
        list = ids.size ? all.filter((a) => ids.has(a.botId)) : all;
      } catch {
        if (live) setState('failed');
        return;
      }
      if (!live) return;
      setAgents(list);

      // One real call per agent, in order. Abandoned if the screen goes away — an
      // assessment nobody is looking at is wasted tenant traffic.
      //
      // `name` and `botId` MUST come from the same row of the same fetch. The
      // server echoes the name it is given rather than reading it from Dataverse,
      // so a name sourced from anywhere older than the botid would attach a
      // permission-inversion warning to the wrong agent — confidently wrong about
      // the one thing a person would act on. Never take the name from elsewhere.
      const failed: string[] = [];
      let i = 0;
      for (const a of list) {
        if (!live) return;
        i += 1;
        setProgress({ done: i, total: list.length, name: a.name });
        try {
          const row = await source.review.assess(session, { botId: a.botId, name: a.name, env: a.env });
          if (!live) return;
          setReviews((prev) => ({ ...prev, [a.botId]: row }));
        } catch {
          failed.push(a.name);
        }
      }
      if (!live) return;
      setUnknown(failed);
      setProgress(undefined);
      setState('done');
    })();
    return () => { live = false; };
  }, [session, source]);

  const assessed = Object.values(reviews);
  const totals = assessed.reduce<Record<Verdict, number>>(
    (acc, r) => ({
      clean: acc.clean + r.counts.clean,
      'needs-review': acc['needs-review'] + r.counts['needs-review'],
      lost: acc.lost + r.counts.lost,
    }),
    { clean: 0, 'needs-review': 0, lost: 0 },
  );

  return {
    agents, reviews, state, unknown, totals, progress,
    lossy: assessed.filter((r) => r.counts.lost > 0),
  };
}

/** The worst verdict present. One lost behaviour outranks twenty clean ones and
 *  must not be averaged away. */
export function worstVerdict(counts: Record<Verdict, number>): Verdict {
  if (counts.lost > 0) return 'lost';
  if (counts['needs-review'] > 0) return 'needs-review';
  return 'clean';
}

/** The card on the canvas: only rendered when there is something to admit. */
export function FidelityCard({ fid }: { fid: Fidelity }) {
  if (fid.lossy.length === 0 && fid.unknown.length === 0) return null;
  return (
    <Panel>
      <PanelHead
        title="What migrating will change"
        sub="Assessed from the source before anything is written. Full findings are in the panel on the right."
      />
      {fid.lossy.length > 0 && (
        <NoteRow tone="bad">
          {fid.totals.lost} behaviour{fid.totals.lost > 1 ? 's' : ''} across {fid.lossy.length} agent
          {fid.lossy.length > 1 ? 's' : ''} cannot come across to Gemini. Read them before you run —
          afterwards this is a report, not a decision.
        </NoteRow>
      )}
      {fid.unknown.length > 0 && (
        <NoteRow tone="you">
          {fid.unknown.length} agent{fid.unknown.length > 1 ? 's' : ''} could not be assessed
          ({fid.unknown.slice(0, 3).join(', ')}{fid.unknown.length > 3 ? ', …' : ''}). That is
          unknown, not clean — nothing is claiming they migrate whole.
        </NoteRow>
      )}
    </Panel>
  );
}

/** The inspector body: totals, then only the findings that mean something. */
export function FidelityDetail({ fid }: { fid: Fidelity }) {
  const assessed = Object.values(fid.reviews);
  return (
    <>
      {fid.state === 'reading' && (
        <Note>
          {fid.progress
            ? `Assessing ${fid.progress.done} of ${fid.progress.total} — ${fid.progress.name}`
            : 'Reading the agents you selected…'}
        </Note>
      )}
      {fid.state === 'failed' && (
        <Note tone="bad">Could not read the selected agents, so nothing here is known yet.</Note>
      )}
      {fid.state === 'done' && assessed.length === 0 && (
        <Note>No agents selected, so there is nothing to assess.</Note>
      )}

      {assessed.length > 0 && (
        <dl>
          <KeyValue k="Maps cleanly" v={fid.totals.clean} />
          <KeyValue k="Needs review after" v={fid.totals['needs-review']} />
          <KeyValue k="Cannot come across" v={fid.totals.lost} />
        </dl>
      )}

      {/* A wall of "clean" hides the three lines that matter. */}
      {fid.agents.map((a) => {
        const r = fid.reviews[a.botId];
        if (!r) return null;
        const bad = r.findings.filter((f) => f.verdict !== 'clean');
        if (bad.length === 0) return null;
        return (
          <div className="v2-fid" key={a.botId}>
            <Note tone={worstVerdict(r.counts) === 'lost' ? 'bad' : 'you'}>
              <b>{a.name}</b> — {r.counts.lost ? `${r.counts.lost} lost` : ''}
              {r.counts.lost && r.counts['needs-review'] ? ', ' : ''}
              {r.counts['needs-review'] ? `${r.counts['needs-review']} to check` : ''}
            </Note>
            {bad.slice(0, 4).map((f, i) => (
              <Note key={`${i}-${f.component}`} tone={f.verdict === 'lost' ? 'bad' : 'you'}>
                {f.component} — {f.detail}
              </Note>
            ))}
            {bad.length > 4 && <Note>+{bad.length - 4} more on this agent.</Note>}
          </div>
        );
      })}

      {/* Named sources, not just a count: "3 sources become org-readable" is a
          statistic, and the person deciding needs to know WHICH documents. */}
      {assessed.filter((r) => r.permissionLoss?.inverts).map((r) => (
        <div className="v2-fid" key={`acl-${r.botId}`}>
          <Note tone="bad">
            <b>{r.name}</b> — {r.permissionLoss?.orgWide
              ? 'becomes readable by the whole organisation'
              : 'source permissions cannot be carried'}
          </Note>
          {(r.permissionLoss?.items ?? []).slice(0, 4).map((it, i) => (
            <Note key={`${i}-${it.source ?? it.detail}`} tone="bad">
              {it.source ?? 'source'}{it.readableBy ? ` — now readable by ${it.readableBy}` : ''}
              {it.detail ? ` · ${it.detail}` : ''}
            </Note>
          ))}
        </div>
      ))}

      {fid.state === 'done' && assessed.length > 0 && fid.totals.lost === 0
        && fid.totals['needs-review'] === 0 && (
        <Note tone="ok">Every assessed agent maps with nothing lost and nothing to check.</Note>
      )}
    </>
  );
}
