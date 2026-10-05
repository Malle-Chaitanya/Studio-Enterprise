"""Resolve a connector operation NAME to a real vendor API call, with no per-app code.

THE PROBLEM THIS SOLVES. A source Copilot agent tells us almost nothing: the connector id
("shared_googledrive") and the operation ids it bound ("ListFolder", "GetFileContent").
Names. For a PASS-THROUGH connector that is already enough -- operationBinding.ts strips
`{connectionId}` off the captured swagger path and the rest IS the vendor path. For Google
it is not: `/datasets/default/files/{id}` is a Power Platform invention, and Drive's real
path is `/drive/v3/files/{fileId}`. 31 of Google Drive's 42 captured operations are that
kind of abstraction. So today each Google app gets a hand-written Python module, and a new
app means a new file.

This probe asks whether the name alone is enough to find the real call. Google is the right
place to ask, because Google is the WORST case: the captured swagger actively misleads. If
names resolve here, they resolve for connectors whose swagger already tells the truth.

WHAT IT MAY USE. Only what a real migration has: the captured operation index (names, verbs,
summaries, parameter names, connectionAuth) and public vendor catalogues. No hand-written
per-app mapping table -- that is the thing being replaced, so using one would beg the
question.

    cd server && python src/spikes/_probe_name_to_api_call.py
    cd server && python src/spikes/_probe_name_to_api_call.py --connector shared_googledrive
    cd server && python src/spikes/_probe_name_to_api_call.py --show ListFolder

Read-only. Fetches public Discovery documents (no auth, cached to temp) and reads committed
fixtures. Sends no vendor request, so nothing can be mutated and no credential is needed.

RESULT, hand-audited against the real Drive/Sheets APIs 2026-10-05. The probe cannot grade
itself, so every row was checked by hand; this is the finding, not the printed tally:

    23 real operations (42 captured, folded over Power Platform's `_Old`/`ODataStyle` aliases)
    11  resolved CORRECTLY        files.copy/create/delete/get/list/update, values.get/update
     3  resolved WRONGLY          AppendFile->files.update (Drive cannot append; it replaces)
                                  GetTables "Get sheets"->values.get (should be spreadsheets.get)
                                  GetFileContentByPath->files.get (Drive has no path lookup;
                                  needs a files.list search first, so it is two calls)
     4  ambiguous, reported       e.g. CreateFolder: docs.documents.create vs drive.files.create
     5  refused, 3 of them right  DeleteItem "Delete Row" correctly refused -- Sheets deletes a
                                  row via spreadsheets.batchUpdate + DeleteDimensionRequest,
                                  which no name can resolve to. 2 were over-cautious
                                  (PostItem -> values.append, GetTable -> spreadsheets.get).

So a name-only system gets roughly half the operations right, flags 39% honestly, and is
CONFIDENTLY WRONG about 1 in 8. The wrong ones are the whole story: `DeleteItem` ("Delete
Row") resolved to `drive.files.delete` until the SURFACE rule landed -- the call that deletes
the entire spreadsheet instead of one row. Nothing in the output marked it as a guess.

Do not tune the scorer until this number looks better. 23 rows with a known answer is few
enough that tuning against them stops measuring and starts memorising; the next connector
would then regress silently. The gap closes with more SIGNAL (see the surface rule, which
came from Power Platform's own path vocabulary and moved the dangerous row into `refused`),
or with a human confirming the residue once per connector -- not with better weights.
"""
import argparse
import io
import json
import pathlib
import re
import sys
import tempfile
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]  # server/
FIXTURES = ROOT / "src" / "connectors" / "fixtures"
CACHE = pathlib.Path(tempfile.gettempdir()) / "csge_discovery_cache"
CACHE.mkdir(exist_ok=True)

DISCOVERY_INDEX = "https://discovery.googleapis.com/discovery/v1/apis?preferred=true"

# Words that carry no routing signal. Deliberately short: over-pruning hides real evidence.
STOP = {"a", "an", "the", "of", "in", "to", "for", "by", "using", "with", "and", "or",
        "this", "that", "from", "on", "at", "it", "its", "your", "you", "all", "one",
        "api", "resource", "resources", "method", "request", "v1", "v2", "v3"}

# PP operation-name / summary verbs -> the Discovery method names that could implement them.
# This is a VOCABULARY, not a per-app mapping: it says what English "list" means in a REST
# catalogue, which is true of every vendor, not of Google in particular.
ACTION = {
    "list": {"list"},
    "get": {"get", "list"},
    "read": {"get"},
    "find": {"list"},
    "search": {"list", "search"},
    "create": {"create", "insert"},
    "insert": {"insert", "create"},
    "post": {"create", "insert"},
    "add": {"create", "insert"},
    "new": {"create", "insert"},
    "update": {"update", "patch"},
    "patch": {"patch", "update"},
    "put": {"update", "patch"},
    "edit": {"update", "patch"},
    "modify": {"update", "patch"},
    "delete": {"delete", "remove", "trash"},
    "remove": {"delete"},
    "copy": {"copy"},
    "move": {"move", "update", "patch"},
    "send": {"send"},
    "append": {"append"},
    "export": {"export"},
    "upload": {"create", "insert"},
    "download": {"get"},
}

# English equivalences only. Everything app-specific was REMOVED after it did real damage:
# an `item -> file` entry (Drive models a folder as a file, so it looked reasonable) made
# `DeleteItem` / "Delete Row" score `noun file` and resolve to `drive.files.delete` -- the
# call that deletes the whole spreadsheet. A synonym table is where app knowledge sneaks
# back into a system that claims not to need any, and it fails in the dangerous direction,
# because a smuggled fact raises a score rather than lowering it. The SURFACE rule below
# does this job properly.
SYNONYM = {
    "row": {"row", "record"},
    "mail": {"message", "mail"},
    "email": {"message", "email"},
}

# Power Platform's OWN path vocabulary, which every connector speaks regardless of vendor.
# `/datasets/{d}/tables/{t}/items/{i}` is Microsoft's tabular contract -- the same shape
# serves Excel, SQL Server, Dataverse and Google Sheets. `/api/blob/...` and
# `/datasets/default/files/...` are its file contract. `$metadata.json` is schema discovery.
# Encoding this is not app knowledge: it is one fixed Microsoft contract that classifies
# every connector's operations at once, which is exactly what the operation NAMES fail to do
# -- "Delete Row" and "Delete file" sit in one connector and differ only by path shape.
SURFACE = [
    (re.compile(r"/\$metadata\.json"), "schema", {"schema"}),
    (re.compile(r"/tables?\b|/tables?\("), "tabular", {"value", "row", "record", "cell", "sheet", "table"}),
    (re.compile(r"/api/blob|/files?\b|/folders?\b"), "file", {"file", "folder", "object", "blob", "document", "media"}),
]


def surface_of(path: str) -> tuple[str, set[str]]:
    """Which Power Platform contract this operation speaks. Tabular wins over file: a Sheets
    row lives at `/datasets/{d}/tables/{t}/items/{i}`, which mentions neither files nor
    folders, while the file operations never mention tables."""
    for rx, name, nouns in SURFACE:
        if rx.search(path or ""):
            return name, nouns
    return "rpc", set()


def tok(s: str) -> list[str]:
    """camelCase / snake / prose -> lowercase word list, trailing plural stripped."""
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", s or "")
    words = [w.lower() for w in re.split(r"[^A-Za-z0-9]+", s) if w]
    out = []
    for w in words:
        if w in STOP or re.fullmatch(r"v?\d+", w):
            continue
        out.append(w)
    return out


def expand(words) -> set[str]:
    """Add synonyms and the singular form, so `rows` can meet `value`."""
    out: set[str] = set()
    for w in words:
        out.add(w)
        if len(w) > 3 and w.endswith("s"):
            out.add(w[:-1])
        out |= SYNONYM.get(w, set())
    return out


def fetch(url: str, key: str) -> dict | None:
    path = CACHE / f"{key}.json"
    if path.exists():
        return json.loads(io.open(path, encoding="utf-8").read())
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            doc = json.loads(r.read().decode("utf-8"))
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
        print(f"  ! fetch failed {key}: {e}", file=sys.stderr)
        return None
    io.open(path, "w", encoding="utf-8").write(json.dumps(doc))
    return doc


def discovery_index() -> dict:
    idx = fetch(DISCOVERY_INDEX, "_index") or {"items": []}
    return {i["name"]: i["discoveryRestUrl"] for i in idx.get("items", [])}


def scope_index(index: dict) -> dict[str, list[str]]:
    """scope -> every api that DECLARES it, built by sweeping Discovery once.

    The first version of this guessed the api name out of the scope string instead
    (`.../auth/drive` -> `drive`) and verified the guess. It verified, and it was still
    wrong: `auth/drive` is declared by `sheets`, `docs`, `slides` and `script` as well as
    `drive`, so a connector asking for it gets the Sheets surface too. Guessing found one
    api where five were true, and every row/table operation in the Google Drive connector
    was then force-matched into Drive -- `DeleteItem` ("Delete Row") resolved to
    `drive.files.delete`, which deletes the whole spreadsheet. A confident, wrong, silent
    answer, which is the exact failure a name-only system has to be built against.

    So: ask the catalogue instead of guessing at it. One sweep, cached; in production this
    is an index built on a schedule and shipped as data, not fetched per migration.
    """
    cached = CACHE / "_scope_index.json"
    if cached.exists():
        return json.loads(io.open(cached, encoding="utf-8").read())

    import concurrent.futures as cf
    print(f"  building scope index from {len(index)} Discovery documents (one time, cached)...",
          file=sys.stderr)
    out: dict[str, list[str]] = {}

    def scopes_of(item):
        api, url = item
        doc = fetch(url, api)
        if not doc:
            return api, []
        return api, list((((doc.get("auth") or {}).get("oauth2") or {}).get("scopes") or {}))

    with cf.ThreadPoolExecutor(max_workers=16) as pool:
        for api, scopes in pool.map(scopes_of, index.items()):
            for s in scopes:
                out.setdefault(s.rstrip("/"), []).append(api)
    io.open(cached, "w", encoding="utf-8").write(json.dumps(out))
    return out


def apis_for_scopes(scopes: list[str], index: dict) -> list[tuple[str, dict]]:
    """Every vendor API reachable with the credential this connector was granted."""
    si = scope_index(index)
    names: list[str] = []
    for scope in scopes or []:
        for api in si.get(scope.rstrip("/"), []):
            if api not in names and api in index:
                names.append(api)
    out = []
    for api in names:
        doc = fetch(index[api], api)
        if doc:
            out.append((api, doc))
    return out


def flatten(doc: dict) -> dict:
    out = {}

    def walk(node, prefix=""):
        for rname, res in (node.get("resources") or {}).items():
            for mname, m in (res.get("methods") or {}).items():
                out[f"{prefix}{rname}.{mname}"] = m
            walk(res, f"{prefix}{rname}.")

    walk(doc)
    return out


# `_Old`, `ODataStyle…` and `…V2` are the SAME operation under another name — Power Platform
# keeps every historical spelling. Canonicalising first means one resolution per real
# operation instead of five near-duplicate guesses, and the alias is still reported.
ALIAS = re.compile(r"(_Old$|^ODataStyle|V\d+$|_V\d+$)")


def canonical(op_id: str) -> str:
    prev = None
    cur = op_id
    while cur != prev:
        prev, cur = cur, ALIAS.sub("", cur)
    return cur or op_id


def score(op_id: str, op: dict, method_name: str, m: dict) -> tuple[float, list[str]]:
    """How well one Discovery method explains one Power Platform operation.

    Four independent signals, each reported as evidence. Nothing here knows what app it is
    looking at -- that is the point. A score with no evidence line is a coincidence.
    """
    why: list[str] = []
    s = 0.0

    name_words = tok(canonical(op_id))
    sum_words = tok(op.get("summary") or "")
    parts = method_name.split(".")
    m_action = parts[-1]
    m_res = parts[-2] if len(parts) > 1 else ""

    # 1. ACTION. What the operation DOES. Strongest single signal, because a `get` that
    #    matches a `delete` is not a near miss -- it is a different operation.
    pp_actions = {w for w in name_words + sum_words if w in ACTION}
    allowed: set[str] = set()
    for a in pp_actions:
        allowed |= ACTION[a]
    if allowed:
        if m_action in allowed:
            s += 4.0
            why.append(f"action {'/'.join(sorted(pp_actions))}->{m_action}")
        else:
            s -= 3.0  # actively wrong verb, not merely unmatched
    # 2. HTTP verb agreement. Weaker than it looks: PP says PUT where Drive says PATCH.
    if (m.get("httpMethod") or "").upper() == (op.get("method") or "").upper():
        s += 1.0
        why.append(f"verb {m.get('httpMethod')}")

    # 3. NOUN, inside the SURFACE the Power Platform path declares. The surface is the
    #    decisive signal and the noun only refines it: a tabular operation must land on a
    #    tabular resource, and scoring it against a file resource is not a weak match but a
    #    wrong one. Without this, every row operation in the Drive connector out-scored its
    #    real Sheets method, because "Delete"+"DELETE"+one-id all agree with files.delete.
    surf, surf_nouns = surface_of(op.get("path") or "")
    nouns = expand(w for w in name_words + sum_words if w not in ACTION)
    res_words = expand(tok(method_name))          # whole chain: spreadsheets.values.append
    hit = nouns & res_words
    if hit:
        s += 2.5
        why.append(f"noun {'/'.join(sorted(hit))}")
    if surf_nouns:
        if res_words & surf_nouns:
            s += 3.0
            why.append(f"surface {surf}")
        else:
            s -= 4.0  # wrong contract entirely; must not out-score a real match

    # 4. CARDINALITY. Does this address ONE thing or a COLLECTION? Reads off the shapes,
    #    not the words: a Power Platform operation taking `id` addresses one record, and a
    #    Discovery path carrying a `{placeholder}` addresses one resource. This is what
    #    separates `GetFileMetadata` (`id` -> files.get) from `ListFolder` (no id ->
    #    files.list), which the verb and the noun cannot -- both score identically on
    #    "get"/"file" and the winner was decided by 0.35 of tie-breaker before this existed.
    visible = [p for p in op.get("parameters", []) if p.get("visibility") != "internal"]
    pp_one = any(re.fullmatch(r"id|path|.*Id", p.get("name", "")) for p in visible)
    pp_many = any(p.get("name", "").lower().lstrip("$") in
                  {"top", "skip", "filter", "pagesize", "pagetoken", "maxresults", "limit"}
                  for p in visible)
    m_one = "{" in (m.get("path") or "")
    if pp_one and not pp_many:
        s += 1.6 if m_one else -1.6
        why.append("cardinality one" if m_one else "")
    elif pp_many and not pp_one:
        s += 1.6 if not m_one else -1.6
        why.append("cardinality many" if not m_one else "")
    why = [w for w in why if w]

    # 5. PARAMETERS. Independent of both names, so it breaks ties the words cannot.
    pp_params = expand(
        w for p in op.get("parameters", []) if p.get("visibility") != "internal"
        for w in tok(p.get("name", ""))
    )
    m_params = expand(w for p in (m.get("parameters") or {}) for w in tok(p))
    shared = {p for p in pp_params & m_params if len(p) > 2}
    if shared:
        s += min(1.5, 0.5 * len(shared))
        why.append(f"params {'/'.join(sorted(shared))[:34]}")

    # 6. DESCRIPTION. The vendor's own prose about the method.
    desc = expand(tok((m.get("description") or "")[:160]))
    dhit = {w for w in (expand(sum_words) & desc) if w not in ACTION and len(w) > 3}
    if dhit:
        s += min(1.0, 0.35 * len(dhit))
        why.append(f"desc {'/'.join(sorted(dhit))[:30]}")

    # Prefer the shallow, primary resource: `files.list` over `files.comments.list`.
    s -= 0.35 * (len(parts) - 2)
    return s, why


# A margin this small means two methods explain the name about equally well. Wiring the
# winner anyway is how `DeleteFile` ends up pointed at the wrong resource, so it is reported
# as ambiguous and left for a human instead.
MARGIN = 1.0
FLOOR = 4.0


def resolve(op_id: str, op: dict, apis: list[tuple[str, dict]]):
    ranked = []
    for api, doc in apis:
        for name, m in flatten(doc).items():
            sc, why = score(op_id, op, name, m)
            ranked.append((sc, api, name, m, why))
    ranked.sort(key=lambda r: -r[0])
    if not ranked or ranked[0][0] < FLOOR:
        return None, ranked[:3], "no method explains this name"
    if len(ranked) > 1 and ranked[0][0] - ranked[1][0] < MARGIN:
        return None, ranked[:3], "ambiguous"
    return ranked[0], ranked[:3], None


def call_of(api: str, doc: dict, name: str, m: dict) -> str:
    base = (doc.get("rootUrl") or "").rstrip("/") + "/" + (doc.get("servicePath") or "").strip("/")
    return f"{m.get('httpMethod')} {base.rstrip('/')}/{(m.get('path') or '').lstrip('/')}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--connector", default="shared_googledrive")
    ap.add_argument("--show", help="print full evidence for one operation id")
    a = ap.parse_args()

    fx = FIXTURES / f"{a.connector}.ops.json"
    if not fx.exists():
        print(f"no captured index for {a.connector}")
        return 1
    index_doc = json.loads(io.open(fx, encoding="utf-8").read())

    ca = index_doc.get("connectionAuth") or {}
    idp = next((v.get("identityProvider") for v in ca.values() if v.get("identityProvider")), None)
    scopes = [s for v in ca.values() for s in (v.get("scopes") or [])]
    print(f"connector        {index_doc['displayName']}  ({index_doc['operationCount']} operations)")
    print(f"identityProvider {idp}")
    print(f"declared scopes  {scopes}")

    idx = discovery_index()
    apis = apis_for_scopes(scopes, idx)
    print(f"resolved vendor APIs (scope verified against each Discovery doc):")
    for api, doc in apis:
        print(f"    {api:12s} {doc.get('title')}  rootUrl={doc.get('rootUrl')}")
    if not apis:
        print("    (none) -- cannot proceed without a vendor catalogue")
        return 1
    print()

    ops = index_doc["operations"]
    if a.show:
        op = ops.get(a.show)
        if not op:
            print(f"no such operation: {a.show}")
            return 1
        best, top, why_not = resolve(a.show, op, apis)
        print(f"{a.show}  {op['method']}  \"{op.get('summary')}\"")
        print(f"  params: {[p['name'] for p in op['parameters'] if p.get('visibility') != 'internal']}\n")
        for sc, api, name, m, why in top:
            print(f"  {sc:6.2f}  {api}.{name}")
            print(f"          {call_of(api, dict(apis)[api], name, m)}")
            print(f"          evidence: {', '.join(why) or '(none)'}")
            print(f"          scopes:   {(m.get('scopes') or ['(none)'])[0]}")
        print(f"\n  verdict: {'RESOLVED -> ' + best[1] + '.' + best[2] if best else 'REFUSED (' + (why_not or '') + ')'}")
        return 0

    # One resolution per REAL operation; aliases reported against their canonical form.
    groups: dict[str, list[str]] = {}
    for oid in ops:
        groups.setdefault(canonical(oid), []).append(oid)

    resolved, ambiguous, refused = [], [], []
    for canon, members in sorted(groups.items()):
        # Resolve against the member that carries the most evidence (a summary).
        rep = max(members, key=lambda o: len(ops[o].get("summary") or ""))
        best, top, why_not = resolve(rep, ops[rep], apis)
        row = (canon, members, rep, ops[rep], best, top, why_not)
        (resolved if best else (ambiguous if why_not == "ambiguous" else refused)).append(row)

    print("=" * 100)
    print("RESOLVED -- name alone found the real vendor call\n")
    for canon, members, rep, op, best, top, _ in resolved:
        sc, api, name, m, why = best
        alias = f"  (+{len(members)-1} alias)" if len(members) > 1 else ""
        print(f"  {canon:24s} \"{(op.get('summary') or '')[:30]:30s}\" -> {api}.{name}{alias}")
        print(f"      {call_of(api, dict(apis)[api], name, m)}")
        print(f"      why: {', '.join(why)}")

    if ambiguous:
        print("\n" + "=" * 100)
        print("AMBIGUOUS -- two methods explain the name equally well; a human picks\n")
        for canon, members, rep, op, _, top, _w in ambiguous:
            print(f"  {canon:24s} \"{(op.get('summary') or '')[:30]}\"")
            for sc, api, name, m, why in top[:2]:
                print(f"      {sc:5.2f} {api}.{name}   ({', '.join(why)})")

    if refused:
        print("\n" + "=" * 100)
        print("REFUSED -- no vendor method implements this; must be reported, never guessed\n")
        for canon, members, rep, op, _, top, why_not in refused:
            top1 = f"best was {top[0][1]}.{top[0][2]} at {top[0][0]:.2f}" if top else "no candidates"
            print(f"  {canon:24s} \"{(op.get('summary') or '(no summary)')[:34]:34s}\" {top1}")

    tot = len(groups)
    print("\n" + "=" * 100)
    print(f"  {len(ops)} captured operations -> {tot} after alias folding")
    print(f"  resolved   {len(resolved):3d}/{tot}")
    print(f"  ambiguous  {len(ambiguous):3d}/{tot}")
    print(f"  refused    {len(refused):3d}/{tot}")
    print("\n  Resolved + ambiguous is the ceiling for a name-only system; refused is the")
    print("  floor that stays hand-written or reported as not migratable. An ambiguous row")
    print("  is a QUESTION, not a failure -- it is the one a wrong guess would have gotten")
    print("  silently wrong.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
