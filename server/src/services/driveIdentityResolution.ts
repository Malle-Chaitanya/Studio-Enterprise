/**
 * Best-effort suggestion for WHICH Google account a Drive-connected agent should
 * impersonate — never a decision. See db/repos/agentConnectorIdentity.ts and
 * docs/connector-architecture-decisions.md §12.5 for why this exists and why it is
 * scoped to the whole environment rather than one agent.
 */
import { getConnectionReferenceOwner, findConnectionReferenceLogicalNames } from './thirdPartyConnectorScan.js';
import { resolvePrincipal } from './identityMap.js';
import type { IdentityMapOverrides } from '../types.js';

export interface DriveIdentitySuggestion {
  email: string;
  reason: string;
}

/**
 * Suggest a Drive identity for this environment, from Microsoft-side hints — never a
 * fact. Two layers of honesty here:
 *
 * 1. A connection reference's owner is a MICROSOFT identity (who set it up in
 *    Copilot Studio), not the Google account it actually authenticated to — that is
 *    confirmed unfetchable via app-only auth (§12.2). This is a correlated hint.
 * 2. Microsoft's app-only API has no reliable way to attribute one connection
 *    reference to one specific agent, so this looks at every Drive connection
 *    reference in the WHOLE environment. If they all point at the same resolved
 *    Google identity, that is a reasonable suggestion for any agent in it. If they
 *    resolve to more than one distinct identity, this returns null rather than
 *    guessing which one a particular agent needs — the admin has to say.
 */
export async function suggestEnvironmentDriveIdentity(
  dvOrgUrl: string,
  dvToken: string,
  ownedDomains: string[],
  overrides: IdentityMapOverrides,
): Promise<DriveIdentitySuggestion | null> {
  const logicalNames = await findConnectionReferenceLogicalNames(dvOrgUrl, dvToken, 'shared_googledrive');
  const candidates = new Map<string, string>(); // resolved Google email -> Microsoft owner name, for the reason text
  for (const logicalName of logicalNames) {
    const owner = await getConnectionReferenceOwner(dvOrgUrl, dvToken, logicalName);
    if (!owner) continue;
    const resolved = resolvePrincipal(
      { type: 'user', id: logicalName, email: owner.ownerEmail, displayName: owner.ownerName },
      { ownedDomains, overrides },
    );
    if (resolved.google?.email) candidates.set(resolved.google.email, owner.ownerName);
  }
  if (candidates.size !== 1) return null; // zero hints, or genuinely conflicting ones — do not guess among them
  const [[email, ownerName]] = candidates;
  return {
    email,
    reason: `Detected from a connection reference set up by ${ownerName} (${email}) — confirm this is right before saving, or change it.`,
  };
}
