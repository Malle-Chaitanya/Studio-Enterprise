import { graphTokenFromRefresh, getVerifiedDomains } from '../auth/microsoft.js';
import { getWorkspaceDomainsAsAdmin, listWorkspaceUsersAsAdmin } from '../auth/google.js';
import { logger } from '../logger.js';
import type { Session } from '../sessionStore.js';
import type { OrganizationProfile } from '../types.js';

/**
 * Build the ORGANIZATION PROFILE — the single source of truth about the customer
 * org that every later phase (classification, planning, reporting) reads from,
 * instead of re-deriving from an admin email. Discovered from BOTH clouds,
 * BEST-EFFORT: a missing scope degrades one field; the profile never throws.
 *
 * Sources for owned domains, in order of reliability:
 *   1. Microsoft tenant verified domains (Graph organization.verifiedDomains)
 *   2. Google Workspace verified domains (Admin SDK Directory)
 *   3. admin email domains (always available fallback: gEmail, msEmail)
 */
export async function buildOrganizationProfile(session: Session, nowIso: string): Promise<OrganizationProfile> {
  const owned = new Set<string>();
  const sources: string[] = [];
  const addDomain = (d?: string | null): void => {
    const v = d?.toLowerCase().trim();
    if (v) owned.add(v);
  };
  const emailDomain = (email?: string): string | undefined => email?.split('@')[1]?.toLowerCase().trim();

  // ── Microsoft ────────────────────────────────────────────────────────────
  const msVerified: string[] = [];
  if (session.refreshToken && session.tenantId) {
    try {
      const graphToken = await graphTokenFromRefresh(session.tenantId, session.refreshToken);
      if (graphToken) {
        const domains = await getVerifiedDomains(graphToken);
        msVerified.push(...domains);
        if (domains.length) sources.push('ms-verified-domains');
      }
    } catch (err) {
      logger.debug({ err }, 'MS verified-domain discovery skipped');
    }
  }
  msVerified.forEach(addDomain);
  const msAdminDomain = emailDomain(session.msEmail);
  addDomain(msAdminDomain);
  if (msAdminDomain && !sources.includes('ms-verified-domains')) sources.push('ms-admin-email');

  // ── Google ─────────────────────────────────────────────────────────────────
  const workspaceDomains: string[] = [];
  try {
    if (session.gEmail) {
      // Directory-scoped DWD token — must not reuse cloud-platform migration token.
      const domains = await getWorkspaceDomainsAsAdmin(session.gEmail);
      workspaceDomains.push(...domains);
      if (domains.length) sources.push('google-workspace-domains');
    }
  } catch (err) {
    logger.debug({ err }, 'Google Workspace domain discovery skipped');
  }
  workspaceDomains.forEach(addDomain);
  const gAdminDomain = emailDomain(session.gEmail);
  addDomain(gAdminDomain);
  if (gAdminDomain && !sources.includes('google-workspace-domains')) sources.push('google-admin-email');

  // Real Workspace user emails — lets identity resolution verify a same-email
  // match actually EXISTS rather than just assuming any address on an owned
  // domain is a real account (that gap fabricated dozens of false "matches").
  // Best-effort: an empty list here means "can't verify," not "no users."
  let verifiedUserEmails: string[] = [];
  if (session.gEmail) {
    try {
      const users = await listWorkspaceUsersAsAdmin(session.gEmail, { max: 500 });
      verifiedUserEmails = users.map((u) => u.email.toLowerCase());
    } catch (err) {
      logger.debug({ err }, 'Google Workspace user discovery skipped');
    }
  }

  return {
    discoveredAt: nowIso,
    microsoft: {
      tenantId: session.tenantId,
      adminEmail: session.msEmail,
      verifiedDomains: [...new Set(msVerified.map((d) => d.toLowerCase()))],
      environments: session.environments ?? [],
    },
    google: {
      adminEmail: session.gEmail,
      project: session.geminiProject,
      workspaceDomains: [...new Set(workspaceDomains.map((d) => d.toLowerCase()))],
      verifiedUserEmails,
    },
    ownedDomains: [...owned],
    domainSources: sources,
  };
}

/**
 * Domains a cross-domain identity match (services/identityMap.ts:
 * matchByUsername) should try — the customer's actual Google Workspace
 * domain(s), never a Microsoft tenant domain. Falls back to the connected
 * admin's own domain when the full Workspace domain listing wasn't readable
 * (missing admin.directory.domain.readonly), so that narrower scope gap
 * doesn't also disable matching against the one domain we already know for
 * certain is real: the admin's own.
 */
export function destinationDomainsOf(profile: OrganizationProfile): string[] {
  const domains = new Set(profile.google.workspaceDomains.map((d) => d.toLowerCase()));
  const adminDomain = profile.google.adminEmail?.split('@')[1]?.toLowerCase().trim();
  if (adminDomain) domains.add(adminDomain);
  return [...domains];
}
