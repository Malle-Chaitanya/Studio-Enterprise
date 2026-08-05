import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

/** Step ids the chat agent can navigate to. */
export type WizardStepId =
  | 'connect'
  | 'pair'
  | 'map-users'
  | 'map'
  | 'select-data'
  | 'connectors'
  | 'migrate'
  | 'report';

export const STEP_ROUTES: Record<WizardStepId, string> = {
  connect: '/connect',
  pair: '/pair',
  'map-users': '/map-users',
  map: '/map',
  'select-data': '/select-data',
  connectors: '/connectors',
  migrate: '/migrate',
  report: '/migrate',
};

export interface WizardToolEvent {
  type: string;
  [key: string]: unknown;
}

type MappingListener = (users: Record<string, string>) => void;
type SelectionListener = () => void;
type MigrateListener = (opts: { dryRun: boolean }) => void;

interface WizardContextValue {
  session: string;
  navigateToStep: (step: WizardStepId | string) => void;
  applyUserMapping: (users: Record<string, string>, merge?: boolean) => void;
  clearUserMappings: () => void;
  setEnvironmentMap: (envs: { env: string; name: string; project?: string; engine?: string }[]) => void;
  setAgentSelection: (units: { env: string; name: string; botIds: string[] }[]) => void;
  requestMigration: (opts: { dryRun: boolean }) => void;
  /** Subscribe to mapping patches from the chat agent. */
  onMappingPatch: (fn: MappingListener) => () => void;
  onSelectionChange: (fn: SelectionListener) => () => void;
  onMigrateRequest: (fn: MigrateListener) => () => void;
  /** Bump when chat applies a tool so pages can reload. */
  toolEpoch: number;
  lastToolEvent: WizardToolEvent | null;
  emitToolEvent: (ev: WizardToolEvent) => void;
  pendingConfirm: { tool: string; args: Record<string, unknown>; message: string } | null;
  setPendingConfirm: (c: { tool: string; args: Record<string, unknown>; message: string } | null) => void;
}

const WizardContext = createContext<WizardContextValue | null>(null);

export function WizardProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const session = params.get('session') ?? '';
  const [toolEpoch, setToolEpoch] = useState(0);
  const [lastToolEvent, setLastToolEvent] = useState<WizardToolEvent | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<{
    tool: string;
    args: Record<string, unknown>;
    message: string;
  } | null>(null);

  const mappingListeners = useRef(new Set<MappingListener>());
  const selectionListeners = useRef(new Set<SelectionListener>());
  const migrateListeners = useRef(new Set<MigrateListener>());

  const navigateToStep = useCallback(
    (step: WizardStepId | string) => {
      const route =
        STEP_ROUTES[step as WizardStepId] ??
        (step.startsWith('/') ? step : `/${step}`);
      const q = session ? `?session=${session}` : '';
      navigate(`${route}${q}`);
      setToolEpoch((n) => n + 1);
      setLastToolEvent({ type: 'navigate_to_step', step });
    },
    [navigate, session],
  );

  const applyUserMapping = useCallback(
    (users: Record<string, string>, merge = true) => {
      if (!session) return;
      let next = { ...users };
      if (merge) {
        try {
          const raw = sessionStorage.getItem(`csge_usermap_${session}`);
          const prev = raw ? (JSON.parse(raw) as Record<string, string>) : {};
          next = { ...prev, ...users };
        } catch {
          /* ignore */
        }
      }
      sessionStorage.setItem(`csge_usermap_${session}`, JSON.stringify(next));
      for (const fn of mappingListeners.current) fn(next);
      setToolEpoch((n) => n + 1);
      setLastToolEvent({ type: 'set_user_mapping', users: next });
    },
    [session],
  );

  const clearUserMappings = useCallback(() => {
    if (!session) return;
    sessionStorage.setItem(`csge_usermap_${session}`, JSON.stringify({}));
    for (const fn of mappingListeners.current) fn({});
    setToolEpoch((n) => n + 1);
    setLastToolEvent({ type: 'clear_mappings' });
  }, [session]);

  const setEnvironmentMap = useCallback(
    (envs: { env: string; name: string; project?: string; engine?: string }[]) => {
      if (!session) return;
      sessionStorage.setItem(`csge_envs_${session}`, JSON.stringify(envs));
      for (const fn of selectionListeners.current) fn();
      setToolEpoch((n) => n + 1);
      setLastToolEvent({ type: 'set_environment_map', envs });
    },
    [session],
  );

  const setAgentSelection = useCallback(
    (units: { env: string; name: string; botIds: string[] }[]) => {
      if (!session) return;
      sessionStorage.setItem(`csge_data_${session}`, JSON.stringify(units));
      for (const fn of selectionListeners.current) fn();
      setToolEpoch((n) => n + 1);
      setLastToolEvent({ type: 'set_agent_selection', units });
    },
    [session],
  );

  const requestMigration = useCallback((opts: { dryRun: boolean }) => {
    for (const fn of migrateListeners.current) fn(opts);
    setToolEpoch((n) => n + 1);
    setLastToolEvent({ type: 'start_migration', dryRun: opts.dryRun });
  }, []);

  const onMappingPatch = useCallback((fn: MappingListener) => {
    mappingListeners.current.add(fn);
    return () => {
      mappingListeners.current.delete(fn);
    };
  }, []);

  const onSelectionChange = useCallback((fn: SelectionListener) => {
    selectionListeners.current.add(fn);
    return () => {
      selectionListeners.current.delete(fn);
    };
  }, []);

  const onMigrateRequest = useCallback((fn: MigrateListener) => {
    migrateListeners.current.add(fn);
    return () => {
      migrateListeners.current.delete(fn);
    };
  }, []);

  const emitToolEvent = useCallback((ev: WizardToolEvent) => {
    setLastToolEvent(ev);
    setToolEpoch((n) => n + 1);
  }, []);

  const value = useMemo(
    () => ({
      session,
      navigateToStep,
      applyUserMapping,
      clearUserMappings,
      setEnvironmentMap,
      setAgentSelection,
      requestMigration,
      onMappingPatch,
      onSelectionChange,
      onMigrateRequest,
      toolEpoch,
      lastToolEvent,
      emitToolEvent,
      pendingConfirm,
      setPendingConfirm,
    }),
    [
      session,
      navigateToStep,
      applyUserMapping,
      clearUserMappings,
      setEnvironmentMap,
      setAgentSelection,
      requestMigration,
      onMappingPatch,
      onSelectionChange,
      onMigrateRequest,
      toolEpoch,
      lastToolEvent,
      emitToolEvent,
      pendingConfirm,
    ],
  );

  return <WizardContext.Provider value={value}>{children}</WizardContext.Provider>;
}

export function useWizard(): WizardContextValue {
  const ctx = useContext(WizardContext);
  if (!ctx) throw new Error('useWizard must be used within WizardProvider');
  return ctx;
}

/** Safe hook for pages that may render outside the shell. */
export function useWizardOptional(): WizardContextValue | null {
  return useContext(WizardContext);
}
