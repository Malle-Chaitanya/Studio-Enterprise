import { clientCredsToken, discoverEnvironments, graphTokenFromRefresh } from '../auth/microsoft.js';
import { getIdentityMap, putIdentityMap } from '../db/repos/identityMap.js';
import { logger } from '../logger.js';
import { listBots } from '../services/dataverse.js';
import { buildOrganizationProfile, destinationDomainsOf } from '../services/organizationProfile.js';
import { suggestMappings } from '../services/identityMap.js';
import { DEFAULT_APP_USER_ID, type Session } from '../sessionStore.js';
import type { PrincipalRef } from '../types.js';
import { CONFIRMATION_MESSAGES, DESTRUCTIVE_TOOLS } from './tools.js';

export type UiEvent = { type: string; [key: string]: unknown };

export interface ToolExecContext {
  session: Session;
  sessionId: string;
  clientState?: {
    envs?: { env: string; name: string }[] | null;
    agents?: { env: string; name: string; botIds: string[] }[] | null;
    userMap?: Record<string, string> | null;
  };
  /** When true, destructive tools may run. */
  confirmed?: boolean;
  emit: (ev: UiEvent) => void;
}

export interface ToolResult {
  ok: boolean;
  message: string;
  data?: unknown;
  /** Pause loop — waiting for user confirm. */
  pause?: boolean;
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function executeTool(
  name: string,
  argsJson: string,
  ctx: ToolExecContext,
): Promise<ToolResult> {
  const args = parseArgs(argsJson);

  if (DESTRUCTIVE_TOOLS.has(name) && !ctx.confirmed) {
    const msgFn = CONFIRMATION_MESSAGES[name];
    const message = msgFn ? msgFn(args) : `Confirm ${name}?`;
    ctx.emit({ type: 'confirm_required', tool: name, args, message });
    return { ok: true, message: 'Awaiting user confirmation.', pause: true };
  }

  try {
    switch (name) {
      case 'navigate_to_step': {
        const step = String(args.step ?? '');
        ctx.emit({ type: 'navigate_to_step', step });
        return { ok: true, message: `Navigated to ${step}.` };
      }
      case 'set_user_mapping': {
        const sourceEmail = String(args.sourceEmail ?? '').toLowerCase().trim();
        const destEmail = String(args.destEmail ?? '').toLowerCase().trim();
        if (!sourceEmail || !destEmail) {
          return { ok: false, message: 'sourceEmail and destEmail are required.' };
        }
        const appUserId = ctx.session.appUserId ?? DEFAULT_APP_USER_ID;
        const tenantId = ctx.session.tenantId ?? '';
        const geminiProject = ctx.session.geminiProject ?? '';
        const existing = await getIdentityMap(appUserId, tenantId, geminiProject);
        const users = { ...(existing.users ?? {}), [sourceEmail]: destEmail };
        await putIdentityMap(appUserId, tenantId, geminiProject, { users, groups: existing.groups ?? {} });
        ctx.emit({ type: 'set_user_mapping', sourceEmail, destEmail, users, merge: true });
        return { ok: true, message: `Mapped ${sourceEmail} → ${destEmail}.` };
      }
      case 'auto_map_users': {
        const appUserId = ctx.session.appUserId ?? DEFAULT_APP_USER_ID;
        const tenantId = ctx.session.tenantId ?? '';
        const geminiProject = ctx.session.geminiProject ?? '';
        const existing = await getIdentityMap(appUserId, tenantId, geminiProject);
        const profile = await buildOrganizationProfile(ctx.session, new Date().toISOString());
        const clientMap = (ctx.clientState?.userMap as Record<string, string>) || {};
        const sourceEmails = new Set([
          ...Object.keys(existing.users ?? {}),
          ...Object.keys(clientMap),
        ]);
        // Pull Graph directory when possible so early Map Users can auto-match.
        try {
          const gToken = await tryGraphToken(ctx.session);
          if (gToken) {
            const { listGraphUsers } = await import('../auth/microsoft.js');
            const ms = await listGraphUsers(gToken, { max: 300 });
            for (const u of ms) sourceEmails.add(u.email);
          }
        } catch {
          /* best-effort */
        }
        const principals: PrincipalRef[] = [...sourceEmails].map((email) => ({
          type: 'user' as const,
          id: email,
          email,
        }));
        const suggested = suggestMappings(
          principals,
          profile.ownedDomains,
          existing,
          profile.google.verifiedUserEmails,
          destinationDomainsOf(profile),
        );
        const users = { ...(existing.users ?? {}), ...suggested.users };
        for (const [src, dest] of Object.entries(clientMap)) {
          if (dest) users[src.toLowerCase()] = dest.toLowerCase();
        }
        const newly = Object.keys(suggested.users).filter((k) => !existing.users?.[k]).length;
        await putIdentityMap(appUserId, tenantId, geminiProject, {
          users,
          groups: { ...(existing.groups ?? {}), ...suggested.groups },
        });
        ctx.emit({ type: 'auto_map_users', users });
        return {
          ok: true,
          message: `Auto-mapped ${newly} user(s) on owned domains (${profile.ownedDomains.join(', ') || 'none'}).`,
          data: { users, ownedDomains: profile.ownedDomains },
        };
      }
      case 'clear_mappings': {
        const appUserId = ctx.session.appUserId ?? DEFAULT_APP_USER_ID;
        const tenantId = ctx.session.tenantId ?? '';
        await putIdentityMap(appUserId, tenantId, ctx.session.geminiProject ?? '', { users: {}, groups: {} });
        ctx.emit({ type: 'clear_mappings' });
        return { ok: true, message: 'Cleared all identity mappings.' };
      }
      case 'list_environments': {
        const tenant = ctx.session.tenantId ?? '';
        if (!tenant) return { ok: false, message: 'Microsoft tenant not connected.' };
        const envs = await discoverEnvironments(tenant);
        return {
          ok: true,
          message: `Found ${envs.length} environment(s).`,
          data: envs.map((e) => ({ name: e.name, url: e.url, id: e.id })),
        };
      }
      case 'set_environment_map': {
        const envs = Array.isArray(args.envs) ? (args.envs as { env: string; name: string }[]) : [];
        ctx.emit({ type: 'set_environment_map', envs });
        return { ok: true, message: `Selected ${envs.length} environment(s).` };
      }
      case 'list_agents': {
        const env = String(args.env ?? '');
        if (!env) return { ok: false, message: 'env URL required.' };
        const token = await clientCredsToken(ctx.session.tenantId ?? '', env);
        const agents = await listBots(env, token);
        return {
          ok: true,
          message: `Found ${agents.length} agent(s).`,
          data: agents.slice(0, 50).map((a) => ({ botid: a.botid, name: a.name, ownerEmail: a.ownerEmail, access: a.accessLabel })),
        };
      }
      case 'set_agent_selection': {
        const units = Array.isArray(args.units)
          ? (args.units as { env: string; name?: string; botIds: string[] }[])
          : [];
        ctx.emit({ type: 'set_agent_selection', units });
        const n = units.reduce((s, u) => s + (u.botIds?.length ?? 0), 0);
        return { ok: true, message: `Selected ${n} agent(s).` };
      }
      case 'start_migration': {
        const dryRun = args.dryRun !== false;
        ctx.emit({ type: 'start_migration', dryRun });
        ctx.emit({ type: 'navigate_to_step', step: 'migrate' });
        return {
          ok: true,
          message: dryRun
            ? 'Dry run requested — open Live Migration and confirm Start if needed.'
            : 'Live migration requested — open Live Migration to run the plan.',
        };
      }
      case 'get_migration_status': {
        const agents = ctx.clientState?.agents ?? [];
        const envs = ctx.clientState?.envs ?? [];
        const map = ctx.clientState?.userMap ?? {};
        const agentCount = Array.isArray(agents)
          ? agents.reduce((n, u) => n + (u.botIds?.length ?? 0), 0)
          : 0;
        const mapped = map && typeof map === 'object' ? Object.keys(map).filter((k) => map[k]).length : 0;
        return {
          ok: true,
          message: `Status: MS=${ctx.session.tenantId ? 'connected' : 'no'}, Google=${ctx.session.gEmail ? 'connected' : 'no'}, envs=${Array.isArray(envs) ? envs.length : 0}, agents=${agentCount}, mappedUsers=${mapped}, plan=${ctx.session.plan ? 'yes' : 'no'}.`,
          data: { envs, agents, mapped, hasPlan: !!ctx.session.plan },
        };
      }
      case 'explain_log': {
        const line = String(args.log_line ?? '');
        let explanation = 'This is a migration progress line.';
        if (/permission|handoff|ALL_USERS/i.test(line)) {
          explanation =
            'Permission-related: Gemini can only share org-wide via ALL_USERS. Narrower Copilot Studio access is recorded as a permission handoff — we do not silently over-share.';
        } else if (/dry.?run/i.test(line)) {
          explanation = 'Dry run: extraction/mapping preview without creating Gemini agents.';
        } else if (/fidelity|needs-review|lost/i.test(line)) {
          explanation =
            'Fidelity note: something could not be mapped 1:1. Check the report for lost vs needs-review.';
        } else if (/connector|sharepoint/i.test(line)) {
          explanation = 'Connector issue: configure SharePoint/OneDrive under Connectors, then re-run.';
        }
        return { ok: true, message: explanation };
      }
      case 'explain_fidelity': {
        return {
          ok: true,
          message:
            'Fidelity report honesty: `lost` means we could not recreate behavior; `needs-review` means a human should verify. Topics, knowledge, and connectors may partially map. Narrow chat access becomes a permission handoff rather than an automatic ALL_USERS share.',
        };
      }
      case 'show_connectors': {
        ctx.emit({ type: 'show_connectors' });
        ctx.emit({ type: 'navigate_to_step', step: 'connectors' });
        return { ok: true, message: 'Opened Connectors.' };
      }
      default:
        return { ok: false, message: `Unknown tool: ${name}` };
    }
  } catch (e) {
    logger.warn(`tool ${name} failed: ${(e as Error).message}`);
    return { ok: false, message: (e as Error).message };
  }
}

/** Best-effort Graph user count helper for rule-based auto-map. */
export async function tryGraphToken(session: Session): Promise<string | null> {
  if (!session.refreshToken || !session.tenantId) return null;
  return graphTokenFromRefresh(session.tenantId, session.refreshToken);
}
