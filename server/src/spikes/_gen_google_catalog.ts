/**
 * GENERATE src/connectors/googleCatalog.ts from Google's Discovery service.
 *
 * Adding a Google app should be a DATA change, not a code change. Today each one is a
 * hand-typed ConnectorDef in registry.ts, and hand-typing them got three of the five wrong
 * in the same way: `shared_googlecalendar`, `shared_googlecontacts` and `shared_googlechat`
 * carry no `impersonation` block, so `impersonating` is false at deploy time and an INVOKER
 * agent on those connectors cannot act as the person asking. The runtime was never the
 * problem -- adk_deploy.py's `_mint_token` keys on `conn.impersonationResolve`, not on the
 * connector kind, so it already serves any Google app. Only the registry rows were wrong,
 * and they were wrong because a human typed five of them separately.
 *
 * Everything below is read off the Discovery document except the POLICY block, which is
 * identical for every Workspace app BECAUSE they all share one service account and one
 * domain-wide-delegation subject. That uniformity is what makes a Google template possible
 * where a Microsoft one is not: Power Platform connectors each carry their own auth shape.
 *
 *   cd server && npx tsx src/spikes/_gen_google_catalog.ts            # print
 *   cd server && npx tsx src/spikes/_gen_google_catalog.ts --write    # write the catalog
 *   cd server && npx tsx src/spikes/_gen_google_catalog.ts --verify   # diff vs registry.ts
 *
 * Read-only against Google (public Discovery, no auth). Writes one file in the repo, and
 * only with --write.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);

/**
 * api name in Discovery -> the connector id this project already uses.
 *
 * The five existing ids are FROZEN: they are Power Automate's own connector names and they
 * key staged rows, so renaming one orphans already-migrated data. New apps follow the same
 * `shared_google<app>` convention Power Automate uses.
 */
const APPS: Array<{ api: string; id: string; icon: string; category: string }> = [
  { api: 'gmail',    id: 'shared_gmail',          icon: '✉️', category: 'storage' },
  { api: 'drive',    id: 'shared_googledrive',    icon: '\u{1F4C1}',    category: 'storage' },
  { api: 'calendar', id: 'shared_googlecalendar', icon: '\u{1F4C5}',    category: 'storage' },
  { api: 'people',   id: 'shared_googlecontacts', icon: '\u{1F4C7}',    category: 'storage' },
  { api: 'chat',     id: 'shared_googlechat',     icon: '\u{1F4AC}',    category: 'messaging' },
  // Apps with no hand-written module today. Each is one row here instead of a new file.
  { api: 'sheets',   id: 'shared_googlesheet',    icon: '\u{1F4CA}',    category: 'storage' },
  { api: 'docs',     id: 'shared_googledocs',     icon: '\u{1F4C4}',    category: 'storage' },
  { api: 'slides',   id: 'shared_googleslides',   icon: '\u{1F4D1}',    category: 'storage' },
  { api: 'tasks',    id: 'shared_googletasks',    icon: '✅',       category: 'collaboration' },
  { api: 'forms',    id: 'shared_googleforms',    icon: '\u{1F4DD}',    category: 'collaboration' },
];

interface Disc {
  title?: string; rootUrl?: string; servicePath?: string; documentationLink?: string;
  auth?: { oauth2?: { scopes?: Record<string, { description?: string }> } };
  resources?: Record<string, unknown>;
}

interface DiscMethod { path?: string; scopes?: string[] }

async function discovery(api: string): Promise<Disc> {
  const idx = (await (await fetch('https://discovery.googleapis.com/discovery/v1/apis?preferred=true')).json()) as
    { items: { name: string; discoveryRestUrl: string }[] };
  const hit = idx.items.find((i) => i.name === api);
  if (!hit) throw new Error(`no Discovery entry for '${api}'`);
  return (await (await fetch(hit.discoveryRestUrl)).json()) as Disc;
}

function methods(doc: Disc): DiscMethod[] {
  const out: DiscMethod[] = [];
  const walk = (node: Record<string, unknown>): void => {
    for (const r of Object.values((node.resources ?? {}) as Record<string, Record<string, unknown>>)) {
      for (const m of Object.values((r.methods ?? {}) as Record<string, DiscMethod>)) out.push(m);
      walk(r);
    }
  };
  walk(doc as Record<string, unknown>);
  return out;
}

/**
 * The base URL, including whatever version prefix this api puts its paths behind.
 *
 * Discovery states that prefix two different ways and both have to be handled, which is why
 * this is computed rather than read from one field. Drive carries `servicePath: 'drive/v3/'`
 * and method paths like `files/{fileId}`. Gmail carries `servicePath: ''` and method paths
 * like `gmail/v1/users/{userId}/messages`. Taking servicePath alone produced
 * `https://gmail.googleapis.com` against the hand-typed `.../gmail/v1` -- not wrong about
 * Google, wrong about where this project's `baseUrlTemplate` boundary sits.
 *
 * So: rootUrl + servicePath + every shared leading segment UP TO AND INCLUDING the version.
 * Stopping at the version matters -- a plain longest-common-prefix gave
 * `https://gmail.googleapis.com/gmail/v1/users`, because every Gmail method really does
 * start `gmail/v1/users/{userId}/`. `users` is a RESOURCE, not part of the base, and folding
 * it in would leave each generated tool's path missing the resource it addresses.
 */
function baseUrl(doc: Disc): string {
  const root = `${(doc.rootUrl ?? '').replace(/\/$/, '')}/${(doc.servicePath ?? '').replace(/^\/|\/$/g, '')}`;
  const paths = methods(doc).map((m) => (m.path ?? '').replace(/^\//, '')).filter(Boolean);
  if (!paths.length) return root.replace(/\/$/, '');
  const segs = paths.map((p) => p.split('/'));
  const common: string[] = [];
  for (let i = 0; i < segs[0].length; i++) {
    const seg = segs[0][i];
    if (seg.includes('{') || !segs.every((p) => p[i] === seg)) break;
    common.push(seg);
    if (/^v\d/.test(seg)) break; // the api version is where the base ends
  }
  return `${root.replace(/\/$/, '')}${common.length ? '/' + common.join('/') : ''}`;
}

/**
 * The DWD scope a human already chose for this app, or '' meaning "compute it per migration".
 *
 * There is NO correct admin scope derivable from Discovery, and the first version of this
 * generator proved it by inventing three wrong ones. Picking "the scope the most methods
 * accept" gave Sheets, Docs, Slides and Forms `https://www.googleapis.com/auth/drive` --
 * every file in the customer's Drive, to use a spreadsheet. It gave Gmail
 * `https://mail.google.com/` (full mailbox including permanent delete) over the
 * deliberately narrower hand-typed `gmail.modify`, and Chat `auth/chat.import`, which only
 * applies to Google's one-off import mode. Each looked authoritative and each was a
 * materially worse grant than a person had already chosen.
 *
 * That is the same failure as `drive.appdata` in _probe_google_scope_plan.ts and the same
 * one _probe_google_connector_def.ts already refuses: the right grant depends on what the
 * agents actually DO, which Discovery cannot know. So the scope is not generated. The five
 * values a human chose are preserved verbatim, and a new app carries '' until the per-
 * migration planner computes it from the resolved operations -- which is also what the
 * Connectors screen should display, since "Chat needs this, Sheets needs that" is exactly
 * the per-app answer the admin has to paste into Workspace.
 */
const CHOSEN_SCOPE: Record<string, string> = {
  // The five below were chosen by a person. The five after them were PROPOSED by
  // spikes/_probe_google_scope_rule.py and accepted: that rule groups an api's declared
  // scopes by family, takes the family this app owns rather than one it borrows, and then the
  // broadest scope inside it. It reproduces all four single-scope choices above exactly
  // (gmail.modify, drive, calendar, contacts), which is why its proposals for the new apps
  // are trusted. It does NOT reproduce Chat, and should not -- Chat needs two scopes and the
  // rule emits one.
  //
  // The rule is what stops Sheets, Docs, Slides and Forms being granted auth/drive, which is
  // what every simpler derivation produced: every file in the customer's Drive, to use a
  // spreadsheet.
  shared_gmail: 'https://www.googleapis.com/auth/gmail.modify',
  shared_googledrive: 'https://www.googleapis.com/auth/drive',
  shared_googlecalendar: 'https://www.googleapis.com/auth/calendar',
  shared_googlecontacts: 'https://www.googleapis.com/auth/contacts',
  shared_googlechat: 'https://www.googleapis.com/auth/chat.messages https://www.googleapis.com/auth/chat.spaces',
  shared_googlesheet: 'https://www.googleapis.com/auth/spreadsheets',
  shared_googledocs: 'https://www.googleapis.com/auth/documents',
  shared_googleslides: 'https://www.googleapis.com/auth/presentations',
  shared_googletasks: 'https://www.googleapis.com/auth/tasks',
  // Forms publishes no bare `auth/forms`; `forms.body` is the broadest it declares.
  shared_googleforms: 'https://www.googleapis.com/auth/forms.body',
};

interface Row {
  id: string; name: string; category: string; icon: string; docsUrl: string;
  baseUrlTemplate: string; scope: string; api: string;
}

async function build(): Promise<Row[]> {
  const rows: Row[] = [];
  for (const app of APPS) {
    const doc = await discovery(app.api);
    rows.push({
      id: app.id,
      name: (doc.title ?? app.api).replace(/ API$/, ''),
      category: app.category,
      icon: app.icon,
      docsUrl: doc.documentationLink ?? '',
      baseUrlTemplate: baseUrl(doc),
      scope: CHOSEN_SCOPE[app.id] ?? '',
      api: app.api,
    });
  }
  return rows;
}

function render(rows: Row[]): string {
  const body = rows.map((r) => `  {
    api: '${r.api}',
    id: '${r.id}',
    name: ${JSON.stringify(r.name)},
    category: '${r.category}',
    icon: '${r.icon}',
    docsUrl: '${r.docsUrl}',
    baseUrlTemplate: '${r.baseUrlTemplate}',
    scope: '${r.scope}',
  },`).join('\n');
  return `/**
 * GENERATED by src/spikes/_gen_google_catalog.ts from Google's Discovery service.
 * Do not hand-edit: re-run the generator instead.
 *
 * Every field here is published by Google. What is NOT here -- the service account, the
 * \`Bearer {access_token}\` header, the domain-wide-delegation subject -- is identical for
 * every Workspace app and lives once in googleConnectors() rather than being retyped per
 * app. Hand-typing it per app is what left shared_googlecalendar, shared_googlecontacts and
 * shared_googlechat with no impersonation block, which silently broke every INVOKER agent on
 * those three connectors.
 *
 * \`scope\` is the DWD grant the admin authorizes, deliberately the app's broad scope: DWD
 * matches scope strings exactly, so the grant must cover the widest string any migration
 * will request. Narrowing what each agent REQUESTS happens per migration, not here.
 *
 * Adding a Google app: add it to APPS in the generator and re-run. No new file, no new
 * registry entry, no new Python module.
 */
export interface GoogleAppRow {
  /** Google Discovery api name — the key for looking its methods up at build time. */
  api: string;
  id: string;
  name: string;
  category: string;
  icon: string;
  docsUrl: string;
  baseUrlTemplate: string;
  /** The exact string the Workspace admin authorizes for domain-wide delegation. */
  scope: string;
}

export const GOOGLE_APPS: GoogleAppRow[] = [
${body}
];
`;
}

/** Pull a hand-typed registry field so the generated value can be checked against it. */
function handTyped(id: string, key: string): string | undefined {
  const src = readFileSync('src/connectors/registry.ts', 'utf8');
  const start = src.indexOf(`id: '${id}'`);
  if (start < 0) return undefined;
  const next = src.indexOf("id: 'shared_", start + 10);
  const seg = src.slice(start, next > 0 ? next : start + 4000);
  return new RegExp(`\\b${key}:\\s*'([^']*)'`).exec(seg)?.[1];
}

const rows = await build();

if (argv.includes('--verify')) {
  console.log('generated vs hand-typed registry.ts\n');
  let diff = 0;
  for (const r of rows) {
    const hand = handTyped(r.id, 'scope');
    if (hand === undefined) { console.log(`  NEW     ${r.id}  (no hand-typed entry)   scope=${r.scope}`); continue; }
    const base = handTyped(r.id, 'baseUrlTemplate');
    const okScope = hand === r.scope, okBase = base === r.baseUrlTemplate;
    if (!okScope || !okBase) diff++;
    console.log(`  ${okScope && okBase ? 'MATCH ' : 'DIFFER'}  ${r.id}`);
    if (!okScope) console.log(`            scope    generated=${r.scope}\n                     hand     =${hand}`);
    if (!okBase) console.log(`            baseUrl  generated=${r.baseUrlTemplate}\n                     hand     =${base}`);
  }
  console.log(`\n${diff} existing connector(s) differ.`);
  console.log('A DIFFER on scope is a decision to make, not automatically a bug: the generated');
  console.log('value is the broadest scope the app declares (what DWD must be authorized for),');
  console.log('and a hand-typed narrower one may have been chosen deliberately.');
  process.exit(0);
}

const out = render(rows);
if (argv.includes('--write')) {
  writeFileSync('src/connectors/googleCatalog.ts', out);
  console.log(`wrote src/connectors/googleCatalog.ts — ${rows.length} Google apps`);
} else {
  console.log(out);
}
