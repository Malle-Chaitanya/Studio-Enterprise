import { createContext, useContext } from 'react';
import { apiSource } from './api.ts';
import { fixtureSource } from './fixture.ts';
import type { V2Source } from './types.ts';

// One re-export point, so a screen never reaches into ./types.ts directly.
export type {
  V2Source, ConnectorRow, ConnectorScan, ScopeEnv, ConnectorsSource,
  CloudLink, ConnectState, ConnectSource,
  EnvRow, DestOption, EnvPair, PairSource,
  UserRow, UsersSource, CandidatePage,
  AgentRow, AgentsSource,
  Verdict, ReviewFinding, ReviewRow, ReviewSource,
  RunLine, RunAgent, RunUpdate, RunStep, RunHandoff, RunEvidence, MigrateSource,
  ReportRow, ReportSource, RunHistoryEntry,
} from './types.ts';
export { apiSource } from './api.ts';
export { fixtureSource } from './fixture.ts';

const SourceContext = createContext<V2Source>(apiSource);
export const SourceProvider = SourceContext.Provider;

/** The data source for the current screen. Real backend unless the shell said otherwise. */
export function useSource(): V2Source {
  return useContext(SourceContext);
}

/**
 * Pick a source for a route.
 *
 * `?fixture=1` selects canned data, and only in a dev build: in production the flag
 * is ignored outright, so no deploy can ever serve invented migration data.
 */
export function resolveSource(search: URLSearchParams): V2Source {
  return import.meta.env.DEV && search.get('fixture') === '1' ? fixtureSource : apiSource;
}
