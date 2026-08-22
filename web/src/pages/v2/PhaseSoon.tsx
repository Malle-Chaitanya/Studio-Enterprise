import { useReducer } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { initialAgentState, reduceAgent } from '../../agent/driver.ts';
import { V2Layout } from '../../components/v2/V2Layout.tsx';
import { Inspector, InspectorHead, InspectorSection, Note, NoteRow, Panel, PanelHead }
  from '../../components/v2/primitives.tsx';
import { OLD_ROUTE, PHASES, type PhaseId } from '../../components/v2/PhaseRail.tsx';

/**
 * Placeholder for a phase whose v2 screen is not built yet.
 *
 * It exists so the rail is navigable end to end while the eight screens land one
 * at a time — and it says plainly that the screen does not exist, pointing at the
 * one that does. A fake screen here would be indistinguishable from a broken one.
 */
export default function PhaseSoon() {
  const { phase } = useParams<{ phase: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [agent, dispatch] = useReducer(reduceAgent, initialAgentState);

  const id = (phase ?? 'connect') as PhaseId;
  const label = PHASES.find((p) => p.id === id)?.label ?? id;
  const oldRoute = `${OLD_ROUTE[id] ?? '/home'}?${params.toString()}`;

  return (
    <V2Layout
      phase={id}
      agent={agent}
      manual
      suggestions={[]}
      onPrompt={() => undefined}
      onStop={() => dispatch({ kind: 'idle' })}
      canvas={
        <Panel>
          <PanelHead
            title={label}
            sub="This phase has no v2 screen yet — it is next in the queue, built in wizard order."
          />
          <NoteRow>
            Nothing here is a real reading of your migration. Use the current UI for this step, or
            open Connectors, which is built.
          </NoteRow>
        </Panel>
      }
      inspector={
        <Inspector>
          <InspectorHead kind="Phase" title={label} />
          <InspectorSection title="Where to go">
            <Note>
              <button
                type="button"
                className="v2-btn wide"
                onClick={() => navigate(`/v2/connectors?${params.toString()}`)}
              >
                Open Connectors (v2)
              </button>
            </Note>
            <Note>
              <button type="button" className="v2-btn wide" onClick={() => navigate(oldRoute)}>
                This step in the current UI
              </button>
            </Note>
          </InspectorSection>
        </Inspector>
      }
    />
  );
}
