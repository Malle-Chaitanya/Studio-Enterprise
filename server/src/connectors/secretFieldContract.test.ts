import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { REGISTRY_BY_ID } from './registry.js';
import { connectorCredentialFields } from '../services/connectorCredentials.js';

/**
 * A field a deployed tool asks for must be one the registry declares.
 *
 * The deployed container reads credentials by NAME — `secret("impersonate_email")`. That name
 * resolves through the spec's `secretIds`, which is built from the registry's declared fields.
 * A name the registry does not declare therefore reads as an empty string in the container, and
 * no amount of configuring can fix it: the field does not exist on the connector screen to be
 * filled in, and writing the secret by hand does not help because nothing references it.
 *
 * Two live cases, both found on 2026-08-22 and both invisible until someone asked a deployed
 * agent to do its job:
 *   - teams.py read `impersonate_email`; MS_GRAPH_FIELDS declared only tenant_id / client_id /
 *     client_secret. Every Teams tool answered "No user is configured for this agent — set the
 *     Teams user on the connector screen", and there was no such field on that screen.
 *   - chat.py gates its five WRITE tools behind `chat_app_configured`, which nothing declared —
 *     so the gate could never open. As Microsoft forbids app-only message POSTs outside import,
 *     Google Chat is the only path to a working send, making that one undeclared field the
 *     thing standing between the product and any messaging write at all.
 *
 * This reads the Python modules and checks each name against the registry, so a tool that starts
 * asking for a new field fails here rather than in front of a customer.
 */

const TOOLS_DIR = join(process.cwd(), 'scripts', 'connector_tools');

/** Which connector ids each module serves — mirrors toolModule.ts resolution. */
const MODULE_FOR: Record<string, string[]> = {
  teams: ['shared_teams'],
  chat: ['shared_googlechat'],
  outlook: ['shared_outlook', 'shared_office365'],
  confluence: ['shared_confluence'],
  jira: ['shared_jira'],
  sharepoint: ['shared_sharepointonline', 'shared_onedrive'],
  google_drive: ['shared_googledrive'],
  hubspot: ['shared_hubspot', 'shared_hubspotcrm', 'shared_hubspotcrmv2', 'shared_hubspotsettingsv2', 'shared_hubspotcms'],
};

/**
 * Names allowed to be undeclared, with the reason. `gmail.impersonate_email` is by design: a
 * mailbox is chosen PER AGENT and injected into secretIds by the orchestrator's surface-mailbox
 * handling. A registry field would invite one mailbox shared by every agent, which is the
 * opposite of the intent — so this exemption is a design statement, not a to-do.
 */
const BY_DESIGN_PER_AGENT: Record<string, string[]> = {
  gmail: ['impersonate_email'],
};

/** Every `secret("...")` name a module reads. */
function fieldsRead(module: string): string[] {
  const src = readFileSync(join(TOOLS_DIR, `${module}.py`), 'utf8');
  const names = [...src.matchAll(/secret\("([a-z_]+)"\)/g)].map((m) => m[1]);
  return [...new Set(names)];
}

describe('runtime secret fields are declared in the registry', () => {
  const modules = readdirSync(TOOLS_DIR)
    .filter((f) => f.endsWith('.py') && f !== '__init__.py' && f !== 'generic_rest.py')
    .map((f) => f.replace(/\.py$/, ''));

  it('finds the connector_tools modules to check', () => {
    expect(modules.length).toBeGreaterThan(4);
  });

  for (const module of modules) {
    const connectorIds = MODULE_FOR[module];
    if (!connectorIds) continue;
    it(`${module}.py only reads fields its connectors declare`, () => {
      const exempt = new Set(BY_DESIGN_PER_AGENT[module] ?? []);
      for (const connectorId of connectorIds) {
        if (!REGISTRY_BY_ID.has(connectorId)) continue;
        const declared = new Set(connectorCredentialFields(connectorId).map((f) => f.key));
        for (const field of fieldsRead(module)) {
          if (exempt.has(field)) continue;
          expect(
            declared.has(field),
            `${module}.py reads secret("${field}") but ${connectorId} does not declare it — ` +
              'the container will read an empty string and the capability is unreachable',
          ).toBe(true);
        }
      }
    });
  }

  it('Teams declares the identity its tools refuse to run without', () => {
    // Named explicitly because the generic check above would pass if teams.py stopped reading
    // the field for the wrong reason. Teams chats belong to a person; app-only Graph reaches
    // every one of them, so the tools demand to be told which.
    const keys = connectorCredentialFields('shared_teams').map((f) => f.key);
    expect(keys).toContain('impersonate_email');
  });

  it('Google Chat declares the write gate, so the send tools can be switched on', () => {
    const keys = connectorCredentialFields('shared_googlechat').map((f) => f.key);
    expect(keys).toContain('chat_app_configured');
  });
});
