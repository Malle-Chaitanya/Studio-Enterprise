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
 *
 * Copilot Studio Share semantics (live-validated): End user = chat only;
 * Agent viewer = Analytics (often blocked for Environment Makers); Editor =
 * edit/configure/publish. Gemini has no per-agent co-admin and only ALL_USERS
 * via API — never auto-grant broader project IAM to "make up" for lost rights.
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

/**
 * Same-username match on a DIFFERENT domain — the normal migration shape
 * (Microsoft tenant domain almost never equals the Google Workspace domain).
 * `erik@filefuze.co` → `erik@migrationn.com` should auto-map by default; only
 * a customer wanting a DIFFERENT person (→ `admin@migrationn.com`) needs an
 * explicit override.
 *
 * Returns a single email on an unambiguous match, the list of candidates when
 * more than one destination domain has this username (never guess which one —
 * a wrong guess silently hands one person's access to another), or undefined
 * when none match. Requires a verified directory listing; there is no
 * "unverified" cross-domain guess — same-domain guessing is already a stretch
 * (see email-match-unverified below), and stacking an unverifiable cross-domain
 * guess on top of that would auto-grant real product access on a coin flip.
 */
function matchByUsername(
  sourceEmail: string,
  destinationDomains: string[],
  knownGoogleUsers: Set<string>,
): string | string[] | undefined {
  const local = sourceEmail.split('@')[0];
  if (!local) return undefined;
  const srcDomain = emailDomain(sourceEmail);
  const candidates = [...new Set(destinationDomains.map((d) => d.toLowerCase()))]
    .filter((d) => d !== srcDomain)
    .map((d) => `${local}@${d}`)
    .filter((candidate) => knownGoogleUsers.has(candidate));
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) return candidates;
  return undefined;
}

export function resolvePrincipal(
  source: PrincipalRef,
  ctx: {
    ownedDomains: string[];
    overrides: IdentityMapOverrides;
    knownGoogleUsers?: string[];
    /** Google Workspace domain(s) to try a same-username match against. See
     *  matchByUsername. Omit (or leave empty) to disable cross-domain matching
     *  and keep the old same-domain-only behavior. */
    destinationDomains?: string[];
  },
): ResolvedPrincipal {
  const owned = new Set(ctx.ownedDomains.map((d) => d.toLowerCase()));
  // Real Workspace accounts, when we could read the directory. Owning a
  // domain never proves a specific address on it exists — only this does.
  const known = ctx.knownGoogleUsers ? new Set(ctx.knownGoogleUsers.map((e) => e.toLowerCase())) : undefined;
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
      // No verified Workspace GROUP directory read exists yet — this stays
      // domain-only (unlike users below), so it's still a guess.
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
  const srcDomain = emailDomain(srcEmail);
  if (srcEmail && srcDomain && owned.has(srcDomain)) {
    if (known) {
      // Directory was readable — only claim a match if the account is real.
      if (known.has(srcEmail)) {
        return { source, google: { type: 'user', email: srcEmail }, via: 'email-match' };
      }
      // The literal address isn't real, but the Microsoft tenant domain and the
      // Google Workspace domain are normally DIFFERENT — try the same username
      // over on the destination domain(s) before giving up.
      const match = matchByUsername(srcEmail, ctx.destinationDomains ?? [], known);
      if (typeof match === 'string') {
        return { source, google: { type: 'user', email: match }, via: 'username-match' };
      }
      if (Array.isArray(match)) {
        return {
          source,
          via: 'unmatched',
          reason: `username "${srcEmail.split('@')[0]}" matches more than one destination account (${match.join(', ')}) — select the intended one manually`,
        };
      }
      return {
        source,
        via: 'unmatched',
        reason: `domain "${srcDomain}" is owned, but no Google Workspace account exists at ${srcEmail} or under the same username on a destination domain`,
      };
    }
    // Directory unreadable (missing scope/API) — can't verify, so this is
    // still a guess, not a confirmed match. Kept permissive (matches prior
    // behavior) but labeled honestly for the fidelity report. A cross-domain
    // guess is never attempted here: stacking an unverifiable guess on top of
    // an already-unverifiable one is how the wrong person gets access.
    return {
      source,
      google: { type: 'user', email: srcEmail },
      via: 'email-match-unverified',
    };
  }
  return {
    source,
    via: 'unmatched',
    reason: srcEmail
      ? `user email domain not in owned domains (${srcDomain}) and no override`
      : 'user has no email and no override mapping',
  };
}

export function resolvePermissions(
  perms: AgentPermissions | undefined,
  ctx: {
    ownedDomains: string[];
    overrides?: IdentityMapOverrides;
    knownGoogleUsers?: string[];
    destinationDomains?: string[];
  },
): PermissionResolution {
  const overrides = ctx.overrides ?? { users: {}, groups: {} };
  const resolve = (p: PrincipalRef) =>
    resolvePrincipal(p, {
      ownedDomains: ctx.ownedDomains,
      overrides,
      knownGoogleUsers: ctx.knownGoogleUsers,
      destinationDomains: ctx.destinationDomains,
    });

  if (!perms) {
    return { owner: undefined, coauthors: [], viewers: [], chatPrincipals: [], unmatched: [] };
  }

  const owner = perms.owner ? resolve(perms.owner) : undefined;
  const coauthors: ResolvedPrincipal[] = [];
  const viewers: ResolvedPrincipal[] = [];
  for (const sp of perms.sharedPrincipals) {
    const r = resolve(sp);
    const isEditor =
      sp.studioShareRole === 'editor' ||
      sp.roleHint === 'coauthor' ||
      (sp.rights ?? []).some((x) => x === 'Write' || x === 'Share');
    if (isEditor) coauthors.push(r);
    else viewers.push(r);
  }

  const chatPrincipals: ResolvedPrincipal[] = [];
  for (const gid of perms.chatAccess?.groupIds ?? []) {
    chatPrincipals.push(resolve({ type: 'group', id: gid, displayName: gid }));
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
 * (email → same email), plus same-username matches on a different destination
 * domain (see matchByUsername) — pre-filling the Map Users screen so the
 * customer reviews/edits a proposal instead of typing every mapping by hand,
 * while still seeing exactly what was guessed before the migration runs.
 * Ambiguous cross-domain matches are deliberately left OUT of the suggestion
 * (not auto-picked) — the customer chooses in the UI, we never do.
 */
export function suggestMappings(
  principals: PrincipalRef[],
  ownedDomains: string[],
  existing: IdentityMapOverrides,
  knownGoogleUsers?: string[],
  destinationDomains?: string[],
): IdentityMapOverrides {
  const owned = new Set(ownedDomains.map((d) => d.toLowerCase()));
  // When the Workspace directory was readable, only suggest a user mapping
  // for an account that actually exists — domain ownership alone previously
  // caused every same-domain user to be "auto-mapped" to itself regardless
  // of whether that address was real, badly inflating auto-mapped counts.
  const known = knownGoogleUsers ? new Set(knownGoogleUsers.map((e) => e.toLowerCase())) : undefined;
  const users = { ...existing.users };
  const groups = { ...existing.groups };
  for (const p of principals) {
    const email = normalizeEmail(p.email);
    if (!email) continue;
    const dom = emailDomain(email);
    if (!dom || !owned.has(dom)) continue;
    if (p.type === 'user' && !users[email]) {
      if (!known || known.has(email)) {
        users[email] = email;
      } else if (destinationDomains?.length) {
        const match = matchByUsername(email, destinationDomains, known);
        // A single confident match becomes the suggestion; ambiguous or no
        // match leaves this principal out of `users` so the UI shows it as
        // still needing the customer's own pick.
        if (typeof match === 'string') users[email] = match;
      }
    }
    // No verified Workspace GROUP directory read exists yet — groups stay
    // domain-only (unchanged), same limitation as resolvePrincipal above.
    if ((p.type === 'group' || p.type === 'team') && !groups[p.id]) groups[p.id] = email;
  }
  return { users, groups };
}

function emailsOf(list: ResolvedPrincipal[]): string[] {
  return [
    ...new Set(
      list
        .map((r) => r.google?.email)
        .filter((e): e is string => Boolean(e))
        .map((e) => e.toLowerCase()),
    ),
  ];
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

  const editorUsers = emailsOf(resolution.coauthors);
  const viewerUsers = emailsOf(resolution.viewers);
  const chatUsers = emailsOf(resolution.chatPrincipals);
  // Owner may need chat/use if they aren't the creating SA identity.
  if (resolution.owner?.google?.type === 'user') {
    chatUsers.push(resolution.owner.google.email.toLowerCase());
  }

  const policy = perms?.chatAccess?.policy ?? 'unknown';
  const steps = [
    'Open Gemini Enterprise (or Cloud Console → Discovery Engine → Agents).',
    `Open agent "${agentName}"${geminiAgentId ? ` (${geminiAgentId})` : ''}.`,
    'Gemini API only supports org-wide ALL_USERS — use console Share / User permissions for everyone else.',
    chatUsers.length
      ? `Chat / end-user access (Studio "End user access"): ${[...new Set(chatUsers)].join(', ')}`
      : 'No mapped chat-only principals beyond owner checklist.',
    editorUsers.length
      ? `Studio Editors (edit/configure/publish on source): ${editorUsers.join(', ')} — Gemini has NO per-agent co-admin. Grant console edit only if the customer explicitly wants it; NEVER auto-grant roles/discoveryengine.editor on the whole GCP project (least-privilege).`
      : 'No Studio Editor shares to re-apply.',
    viewerUsers.length
      ? `Studio Agent viewers (Analytics/Evaluation): ${viewerUsers.join(', ')} — no Gemini equivalent. On source, Agent viewer often conflicts with Environment Maker; treat as needs-review, not silent drop.`
      : 'No Agent-viewer shares recorded.',
    `Source chat policy was "${policy}". On Standard/Plus, gallery listing may still require ADK (ENABLED) or a direct agent link — do not claim org gallery visibility from ALL_USERS alone.`,
    'Security rule: never grant a broader destination permission to compensate for a narrower source right you cannot replicate.',
  ];

  return {
    agentName,
    geminiAgentId,
    reason,
    grantUsers: [...grantUsers],
    grantGroups: [...grantGroups],
    chatUsers: [...new Set(chatUsers)],
    editorUsers,
    viewerUsers,
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
        `${handoff.reason} Chat users: ${handoff.chatUsers?.length ?? 0}; ` +
        `editors: ${handoff.editorUsers?.length ?? 0}; viewers: ${handoff.viewerUsers?.length ?? 0}; ` +
        `unresolved: ${handoff.unresolved.length}.`,
    });
  }

  const editors = (perms?.sharedPrincipals ?? []).filter(
    (s) => s.studioShareRole === 'editor' || s.roleHint === 'coauthor',
  );
  if (editors.length) {
    notes.push({
      component: 'permissions-editor',
      status: 'needs-review',
      detail:
        `${editors.length} Studio Editor/coauthor(s) on source. Gemini has no per-agent co-admin; ` +
        `do not auto-grant project-wide IAM. Manual console share only if customer confirms.`,
    });
  }

  const viewers = (perms?.sharedPrincipals ?? []).filter(
    (s) => s.studioShareRole === 'agent-viewer' || (s.roleHint === 'viewer' && s.studioShareRole !== 'editor'),
  );
  if (viewers.length) {
    notes.push({
      component: 'permissions-viewer',
      status: 'needs-review',
      detail:
        `${viewers.length} read-only share(s) (Studio's Analytics Viewer and/or Agent viewer/Evaluations ` +
        `roles — two distinct native mechanisms currently bucketed together here). Gemini has no ` +
        `equivalent for either at any grain — report only.`,
    });
  }

  if (perms?.owner) {
    const label = perms.owner.email || perms.owner.displayName || perms.owner.id;
    notes.push({
      component: 'ownership',
      status: 'needs-review',
      detail:
        `Source owner is ${label} (personal agent case if private). Gemini creator attribution ` +
        `follows the creating identity (SA / DWD); mapped owner must be granted via console if different.`,
    });
  }

  // Enterprise matrix reminder when permissions exist at all.
  if (perms && (perms.owner || perms.sharedPrincipals.length || perms.chatAccess)) {
    notes.push({
      component: 'permissions-matrix',
      status: 'mapped',
      detail:
        'Enterprise cases captured: (1) owner personal agents, (2) Studio Editors, (3) chat/end-user & org-wide. ' +
        'View-only Studio Agent viewer is often unusable for Environment Makers on source.',
    });
  }

  return notes;
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
    const editor =
      sp.studioShareRole === 'editor' ||
      sp.roleHint === 'coauthor' ||
      (sp.rights ?? []).some((x) => x === 'Write' || x === 'Share');
    add(editor ? 'editor' : 'viewer', sp);
  }
  for (const gid of perms.chatAccess?.groupIds ?? []) {
    add('chat-group', { type: 'group', id: gid, displayName: gid });
  }
}
