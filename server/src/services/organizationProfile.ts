import { graphTokenFromRefresh, getVerifiedDomains } from '../auth/microsoft.js';
import { getSaToken, getWorkspaceDomains } from '../auth/google.js';
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
      const saToken = await getSaToken(session.gEmail);
      const domains = await getWorkspaceDomains(saToken);
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
    },
    ownedDomains: [...owned],
    domainSources: sources,
  };
}
