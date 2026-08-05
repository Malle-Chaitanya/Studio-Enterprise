import type {
  AgentPermissions,
  FidelityNote,
  IdentityMapOverrides,
  PermissionHandoff,
  PermissionResolution,
  PrincipalRef,
  ResolvedPrincipal,
} from '../types.js';

/**
 * Pure-ish identity + permission resolution.
 * Maps Microsoft principals → Google Workspace principals using customer
 * overrides first, then same-email match on owned domains. Never guesses.
 */

function emailDomain(email?: string): string | undefined {
  const e = email?.trim().toLowerCase();
  if (!e || !e.includes('@')) return undefined;
  return e.split('@')[1];
}

function normalizeEmail(email?: string): string | undefined {
  const e = email?.trim().toLowerCase();
  return e || undefined;
}

export function resolvePrincipal(
  source: PrincipalRef,
  ctx: { ownedDomains: string[]; overrides: IdentityMapOverrides },
): ResolvedPrincipal {
  const owned = new Set(ctx.ownedDomains.map((d) => d.toLowerCase()));
  const srcEmail = normalizeEmail(source.email);

  if (source.type === 'group' || source.type === 'team') {
    const ov = ctx.overrides.groups[source.id];
    if (ov) {
      return {
        source,
        google: { type: 'group', email: ov.toLowerCase() },
        via: 'override',
      };
    }
    if (srcEmail && owned.has(emailDomain(srcEmail) ?? '')) {
      return {
        source,
        google: { type: 'group', email: srcEmail },
        via: 'group-match',
      };
    }
    return {
      source,
      via: 'unmatched',
      reason: srcEmail
        ? `group email domain not in owned domains (${emailDomain(srcEmail)})`
        : 'group has no email and no override mapping',
    };
  }

  // user
  if (srcEmail && ctx.overrides.users[srcEmail]) {
    return {
      source,
      google: { type: 'user', email: ctx.overrides.users[srcEmail] },
      via: 'override',
    };
  }
  if (srcEmail && owned.has(emailDomain(srcEmail) ?? '')) {
    return {
      source,
      google: { type: 'user', email: srcEmail },
      via: 'email-match',
    };
  }
  return {
    source,
    via: 'unmatched',
    reason: srcEmail
      ? `user email domain not in owned domains (${emailDomain(srcEmail)}) and no override`
      : 'user has no email and no override mapping',
  };
}

export function resolvePermissions(
  perms: AgentPermissions | undefined,
  ctx: { ownedDomains: string[]; overrides?: IdentityMapOverrides },
): PermissionResolution {
  const overrides = ctx.overrides ?? { users: {}, groups: {} };
  const resolve = (p: PrincipalRef) => resolvePrincipal(p, { ownedDomains: ctx.ownedDomains, overrides });

  if (!perms) {
    return { owner: undefined, coauthors: [], viewers: [], chatPrincipals: [], unmatched: [] };
  }

  const owner = perms.owner ? resolve(perms.owner) : undefined;
  const coauthors: ResolvedPrincipal[] = [];
  const viewers: ResolvedPrincipal[] = [];
  for (const sp of perms.sharedPrincipals) {
    const r = resolve(sp);
    if (sp.roleHint === 'coauthor') coauthors.push(r);
    else viewers.push(r);
  }

  const chatPrincipals: ResolvedPrincipal[] = [];
  for (const gid of perms.chatAccess?.groupIds ?? []) {
    chatPrincipals.push(
      resolve({ type: 'group', id: gid, displayName: gid }),
    );
  }

  const all = [
    ...(owner ? [owner] : []),
    ...coauthors,
    ...viewers,
    ...chatPrincipals,
  ];
  const unmatched = all.filter((r) => r.via === 'unmatched');

  return { owner, coauthors, viewers, chatPrincipals, unmatched };
}

/** True when source chat access is org-wide (maps to Gemini ALL_USERS). */
export function isOrgWideChat(perms?: AgentPermissions): boolean {
  const p = perms?.chatAccess?.policy;
  return p === 'any' || p === 'any-multitenant';
}

/**
 * Suggest override entries for unmatched principals that share an owned domain
 * (email → same email). Does not invent cross-domain mappings.
 */
export function suggestMappings(
  principals: PrincipalRef[],
  ownedDomains: string[],
  existing: IdentityMapOverrides,
): IdentityMapOverrides {
  const owned = new Set(ownedDomains.map((d) => d.toLowerCase()));
  const users = { ...existing.users };
  const groups = { ...existing.groups };
  for (const p of principals) {
    const email = normalizeEmail(p.email);
    if (!email) continue;
    const dom = emailDomain(email);
    if (!dom || !owned.has(dom)) continue;
    if (p.type === 'user' && !users[email]) users[email] = email;
    if ((p.type === 'group' || p.type === 'team') && !groups[p.id]) groups[p.id] = email;
  }
  return { users, groups };
}

export function buildPermissionHandoff(
  agentName: string,
  geminiAgentId: string | undefined,
  resolution: PermissionResolution,
  perms: AgentPermissions | undefined,
  reason: string,
): PermissionHandoff {
  const grantUsers = new Set<string>();
  const grantGroups = new Set<string>();
  const unresolved: { source: string; reason: string }[] = [];

  const consider = (r: ResolvedPrincipal | undefined) => {
    if (!r) return;
    if (r.google) {
      if (r.google.type === 'group') grantGroups.add(r.google.email);
      else grantUsers.add(r.google.email);
    } else {
      unresolved.push({
        source: r.source.email || r.source.displayName || r.source.id,
        reason: r.reason ?? 'unmatched',
      });
    }
  };

  consider(resolution.owner);
  for (const r of resolution.coauthors) consider(r);
  for (const r of resolution.viewers) consider(r);
  for (const r of resolution.chatPrincipals) consider(r);

  const policy = perms?.chatAccess?.policy ?? 'unknown';
  const steps = [
    'Open the Gemini Enterprise Agent Gallery (or Cloud Console → Agents).',
    `Open agent "${agentName}"${geminiAgentId ? ` (${geminiAgentId})` : ''}.`,
    'Use Share (owner) or User permissions (admin) — Gemini has no API for per-user/group agent sharing today.',
    grantUsers.size
      ? `Add these users: ${[...grantUsers].join(', ')}`
      : 'No mapped Google users to add (see unresolved).',
    grantGroups.size
      ? `Add these groups: ${[...grantGroups].join(', ')}`
      : 'No mapped Google groups to add.',
    `Source chat policy was "${policy}" — do not share org-wide unless that matches intent.`,
  ];

  return {
    agentName,
    geminiAgentId,
    reason,
    grantUsers: [...grantUsers],
    grantGroups: [...grantGroups],
    unresolved,
    steps,
  };
}

export function permissionFidelityNotes(
  perms: AgentPermissions | undefined,
  appliedOrgWide: boolean,
  handoff: PermissionHandoff | undefined,
): FidelityNote[] {
  const notes: FidelityNote[] = [];
  if (perms?.readError) {
    notes.push({
      component: 'sharing',
      status: 'needs-review',
      detail: `Source shares could not be fully read: ${perms.readError}`,
    });
  }
  if (appliedOrgWide) {
    notes.push({
      component: 'sharing',
      status: 'mapped',
      detail: 'Source allowed org-wide chat access → shared with ALL_USERS.',
    });
  } else if (handoff) {
    notes.push({
      component: 'sharing',
      status: 'needs-review',
      detail:
        `${handoff.reason} Mapped users: ${handoff.grantUsers.length || 'none'}; ` +
        `groups: ${handoff.grantGroups.length || 'none'}; unresolved: ${handoff.unresolved.length}.`,
    });
  }
  if (resolutionOwnerNote(perms)) notes.push(resolutionOwnerNote(perms)!);
  return notes;
}

function resolutionOwnerNote(perms: AgentPermissions | undefined): FidelityNote | undefined {
  if (!perms?.owner) return undefined;
  const label = perms.owner.email || perms.owner.displayName || perms.owner.id;
  return {
    component: 'ownership',
    status: 'needs-review',
    detail:
      `Source owner is ${label}. Gemini agent ownership follows the creating identity ` +
      `(SA / DWD admin); intended owner must be granted via console Share if different.`,
  };
}

/** Deduped catalog entry for the Map Users UI. */
export interface DiscoveredPrincipal {
  key: string;
  role: 'owner' | 'editor' | 'viewer' | 'chat-group' | 'org-wide';
  source: PrincipalRef;
  agentIds: string[];
  agentNames: string[];
}

export function catalogPrincipalsFromPermissions(
  agentId: string,
  agentName: string,
  perms: AgentPermissions | undefined,
  into: Map<string, DiscoveredPrincipal>,
): void {
  if (!perms) return;

  const add = (role: DiscoveredPrincipal['role'], source: PrincipalRef) => {
    const key = `${source.type}:${source.id}`;
    const existing = into.get(key);
    if (existing) {
      if (!existing.agentIds.includes(agentId)) {
        existing.agentIds.push(agentId);
        existing.agentNames.push(agentName);
      }
      // Prefer richer role if we see owner/editor on another agent.
      const rank = { owner: 4, editor: 3, viewer: 2, 'chat-group': 1, 'org-wide': 0 };
      if (rank[role] > rank[existing.role]) existing.role = role;
      if (!existing.source.email && source.email) existing.source = { ...existing.source, ...source };
      return;
    }
    into.set(key, {
      key,
      role,
      source: { ...source },
      agentIds: [agentId],
      agentNames: [agentName],
    });
  };

  if (perms.chatAccess?.policy === 'any' || perms.chatAccess?.policy === 'any-multitenant') {
    add('org-wide', {
      type: 'group',
      id: 'org-wide',
      displayName: 'Everyone in organization',
      email: undefined,
    });
  }
  if (perms.owner) add('owner', perms.owner);
  for (const sp of perms.sharedPrincipals) {
    add(sp.roleHint === 'coauthor' ? 'editor' : 'viewer', sp);
  }
  for (const gid of perms.chatAccess?.groupIds ?? []) {
    add('chat-group', { type: 'group', id: gid, displayName: gid });
  }
}
