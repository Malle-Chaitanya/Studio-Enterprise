"""How much of our hand-written Google connector code could a Discovery-driven builder replace?

The question behind the "one generic Google builder instead of a file per app" design: the
five modules in scripts/connector_tools/ are ~3,200 lines of hand-written Python. Google
publishes a machine-readable Discovery document for every API it has. If a generic builder
could emit the same tools from that document, a NEW Google app needs index data, not code.

It cannot replace all of them, and guessing which is the whole point of this probe. So:
AST-walk every tool in every Google module, work out which Discovery method(s) it calls,
and classify what a generic builder would actually produce in its place.

    cd server && python src/spikes/_probe_google_discovery_coverage.py
    cd server && python src/spikes/_probe_google_discovery_coverage.py --verbose

Read-only. Fetches public Discovery docs (no auth, no customer data) and caches them under
the OS temp dir so repeat runs are offline.

VERDICTS
  generic    one Discovery method, no payload assembly -> a generic builder emits this tool
             essentially as-is. Pure win.
  composite  several Discovery methods in one tool (list, then fetch each hit). A generic
             builder emits them as SEPARATE tools and the model has to chain them. Possible,
             but more turns and more ways to go wrong -- a downgrade, not a blocker.
  assembly   the request body is a format the Discovery doc describes but does not build:
             Gmail's `raw` is "an RFC 2822 formatted and base64url encoded string". A generic
             tool would expose `raw: str` and ask the model to assemble MIME. That is the one
             class that genuinely must stay hand-written.
  unmatched  no Discovery method matched. Either a local helper that makes no HTTP call, or
             a path shape this probe failed to normalise -- reported either way rather than
             silently scored, because a miscount here would flatter the design.
"""
import ast
import io
import json
import os
import pathlib
import re
import sys
import tempfile
import urllib.request

VERBOSE = "--verbose" in sys.argv

ROOT = pathlib.Path(__file__).resolve().parents[2] / "scripts" / "connector_tools"
CACHE = pathlib.Path(tempfile.gettempdir()) / "csge_google_discovery"
CACHE.mkdir(exist_ok=True)

# module -> (discovery api, version, the host prefix its paths hang off)
MODULES = {
    "gmail.py":        ("gmail",    "v1", "gmail.googleapis.com"),
    "google_drive.py": ("drive",    "v3", "www.googleapis.com"),
    "calendar.py":     ("calendar", "v3", "www.googleapis.com"),
    "contacts.py":     ("people",   "v1", "people.googleapis.com"),
    "chat.py":         ("chat",     "v1", "chat.googleapis.com"),
}

DISCOVERY = {
    "gmail":    "https://gmail.googleapis.com/$discovery/rest?version=v1",
    "drive":    "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest",
    "calendar": "https://calendar-json.googleapis.com/$discovery/rest?version=v3",
    "people":   "https://people.googleapis.com/$discovery/rest?version=v1",
    "chat":     "https://chat.googleapis.com/$discovery/rest?version=v1",
}

# Payload formats the Discovery doc NAMES but does not construct. Presence of these in a
# tool's body is what separates "generic can do it" from "must stay hand-written".
ASSEMBLY_SIGNALS = (
    "base64", "MIMEText", "MIMEMultipart", "EmailMessage", "as_bytes",
    "uploadType", "multipart", "RFC 2822", "rfc2822",
)


def fetch_discovery(api: str) -> dict:
    """Discovery doc for one API, cached on disk -- these change on Google's cadence, not ours."""
    path = CACHE / f"{api}.json"
    if path.exists():
        return json.loads(io.open(path, encoding="utf-8").read())
    with urllib.request.urlopen(DISCOVERY[api], timeout=30) as r:
        doc = json.loads(r.read().decode("utf-8"))
    io.open(path, "w", encoding="utf-8").write(json.dumps(doc))
    return doc


def discovery_methods(doc: dict) -> dict:
    """{'users.messages.list': {...}} -- resources nest arbitrarily deep, so recurse."""
    out = {}

    def walk(node, prefix=""):
        for rname, res in (node.get("resources") or {}).items():
            for mname, m in (res.get("methods") or {}).items():
                out[f"{prefix}{rname}.{mname}"] = m
            walk(res, f"{prefix}{rname}.")

    walk(doc)
    return out


def shape(path: str, api: str) -> str:
    """Collapse a URL path to a shape comparable across both sides.

    Two mismatches have to be normalised away, and the second is the one that matters:

    1. Variable spelling. Discovery says `{userId}`, the module hardcodes `me`; Discovery
       says `{fileId}`, an f-string says `{file_id}`. Every variable-ish segment -> `*`.
       `me` counts as a variable because DWD makes it mean "the impersonated subject".

    2. PREFIXES, which differ PER API. Discovery's `path` is relative to the doc's
       servicePath for some APIs (drive: `files`) and carries the api/version itself for
       others (gmail: `gmail/v1/users/{userId}/messages`). Module URLs always carry the
       full prefix. Scoring these against each other without stripping the prefix marked
       35% of tools unmatched on the first run -- Drive and Calendar failed wholesale --
       which would have understated the design's coverage badly.

    So: drop leading segments that are the api name, an alias of it, or a version.
    """
    path = path.split("?")[0].strip("/")
    segs = [s for s in path.split("/") if s]
    # Aliases: the module's URL host path does not always equal the Discovery api name.
    aliases = {api, {"people": "people", "drive": "drive", "chat": "chat",
                     "calendar": "calendar", "gmail": "gmail"}.get(api, api), "upload"}
    while segs and (segs[0] in aliases or re.fullmatch(r"v\d+[a-z]*", segs[0])):
        segs.pop(0)
    return "/".join(
        "*" if (s.startswith("{") or s == "me") else s
        for s in segs
    )


def literals(node: ast.AST) -> list:
    """Every string a node builds, with f-string placeholders flattened to `{}`."""
    out = []
    for n in ast.walk(node):
        if isinstance(n, ast.Constant) and isinstance(n.value, str):
            out.append(n.value)
        elif isinstance(n, ast.JoinedStr):
            s = ""
            for part in n.values:
                s += part.value if isinstance(part, ast.Constant) else "{}"
            out.append(s)
    return out


def tool_functions(tree: ast.AST) -> list:
    """The ADK tools a module exposes: functions defined directly inside build_tools whose
    name does not start with `_`. Everything underscored is a private helper."""
    bt = next(
        (n for n in ast.walk(tree)
         if isinstance(n, ast.FunctionDef) and n.name == "build_tools"),
        None,
    )
    if bt is None:
        return []
    return [n for n in bt.body
            if isinstance(n, ast.FunctionDef) and not n.name.startswith("_")]


def helper_paths(tree: ast.AST) -> dict:
    """Private helpers often hold the base URL (`_get` builds f"{API}{path}").
    Map helper name -> the path fragments it contributes, so a tool that calls
    `_get("/messages")` still resolves to a full path."""
    bt = next((n for n in ast.walk(tree)
               if isinstance(n, ast.FunctionDef) and n.name == "build_tools"), None)
    if bt is None:
        return {}
    return {n.name: literals(n) for n in ast.walk(bt)
            if isinstance(n, ast.FunctionDef) and n.name.startswith("_")}


def shape_match(mod_shape: str, disc_shape: str) -> bool:
    """Segment-wise match where `*` on EITHER side matches any one segment.

    Exact string equality is not enough: Discovery says `calendars/{calendarId}/events`
    while the module hardcodes the default calendar as `calendars/primary/events`. The
    literal `primary` is a real id, not a variable, so normalising it away generically
    would be wrong -- but Discovery's own `{calendarId}` is a wildcard, and that is what
    makes the two comparable. Same story for Drive's `{fileId}` against an f-string.
    """
    a, b = mod_shape.split("/"), disc_shape.split("/")
    if len(a) != len(b):
        return False
    if not all(x == y or x == "*" or y == "*" for x, y in zip(a, b)):
        return False
    # At least one REAL segment must agree. Google's newer APIs address resources as
    # `v1/{+name}`, which normalises to a bare `*` and would otherwise wildcard-match every
    # single-segment path we have: Chat's `/spaces` was matching `users.availability.get`
    # and nine others, inflating `composite` -- i.e. flattering the design with a number
    # that was not real.
    return any(x == y and x != "*" for x, y in zip(a, b))


# Which HTTP verb a path argument is being sent with. Without this, wildcard matching
# collapses list/insert (both `calendars/*/events`) into one tool and every Calendar tool
# scores `composite` -- the verb is the only thing that tells them apart.
HELPER_VERBS = {"_get": "GET", "_write": "POST", "_post": "POST", "_call": None}


def verb_paths(fn: ast.FunctionDef) -> list:
    """[(verb or None, path string)] for every API call this tool makes."""
    out = []
    for n in ast.walk(fn):
        if not isinstance(n, ast.Call):
            continue
        # google_drive.py builds its requests inline -- `urllib.request.Request(url, ...)`
        # is an ast.Attribute, not an ast.Name, so a Name-only walk missed every Drive tool
        # and scored all 10 as unmatched. The verb comes from the `method=` kwarg there.
        name = n.func.id if isinstance(n.func, ast.Name) else ""
        if name not in HELPER_VERBS and "googleapis" not in "".join(literals(n)):
            continue
        # A bare urllib Request with no method= is a GET, same as the stdlib default.
        verb = HELPER_VERBS.get(name, "GET" if not name else None)
        # `_write(path, body, token, method="PATCH")` overrides the helper default.
        for kw in n.keywords:
            if kw.arg == "method" and isinstance(kw.value, ast.Constant):
                verb = kw.value.value
        args = list(n.args)
        # chat.py's `_call(method, path, ...)` puts the verb first, positionally.
        if name == "_call" and args and isinstance(args[0], ast.Constant):
            verb = args[0].value
            args = args[1:]
        for a in args[:1] or args:
            for s in literals(a):
                if s.startswith("/") or "googleapis.com" in s:
                    out.append((verb, s))

    # Fallback for the common `url = "https://..." + urlencode(params)` then
    # `Request(url, ...)` shape -- the literal lives in an Assign, not in the call's args,
    # so the Call walk above never sees it. Drive is written entirely this way.
    if not out:
        verbs = {kw.value.value
                 for n in ast.walk(fn) if isinstance(n, ast.Call)
                 for kw in n.keywords
                 if kw.arg == "method" and isinstance(kw.value, ast.Constant)}
        verb = verbs.pop() if len(verbs) == 1 else None if verbs else "GET"
        for s in literals(fn):
            if "googleapis.com" in s:
                out.append((verb, s))
    return out


def classify(fn: ast.FunctionDef, module_src: str, api_base: str, helpers: dict,
             shapes: dict, api: str, methods: dict) -> tuple:
    """-> (verdict, [matched discovery method names], [assembly signals found])"""
    pairs = verb_paths(fn)
    # A tool that delegates to a path-holding helper inherits that helper's fragments.
    called = {n.func.id for n in ast.walk(fn)
              if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)}
    for h in called & set(helpers):
        pairs += [(HELPER_VERBS.get(h), s) for s in helpers[h]
                  if s.startswith("/") or "googleapis.com" in s]

    matched = []
    for verb, s in pairs:
        p = s.split("googleapis.com", 1)[1] if "googleapis.com" in s else api_base + s
        sh = shape(p, api)
        if not sh or sh == "*":
            continue
        for name, msh in shapes.items():
            if name in matched or not shape_match(sh, msh):
                continue
            if verb and methods[name].get("httpMethod") != verb:
                continue
            matched.append(name)

    src = ast.get_source_segment(module_src, fn) or ""
    signals = sorted({sig for sig in ASSEMBLY_SIGNALS if sig in src})

    if signals:
        return "assembly", matched, signals
    if len(matched) > 1:
        return "composite", matched, []
    if len(matched) == 1:
        return "generic", matched, []
    return "unmatched", [], []


def main() -> int:
    totals = {"generic": 0, "composite": 0, "assembly": 0, "unmatched": 0}
    rows = []

    for mod, (api, ver, host) in MODULES.items():
        path = ROOT / mod
        if not path.exists():
            print(f"  !! {mod} not found, skipping")
            continue
        src = io.open(path, encoding="utf-8").read()
        tree = ast.parse(src)

        doc = fetch_discovery(api)
        methods = discovery_methods(doc)
        shapes = {n: shape(m.get("path", ""), api) for n, m in methods.items()}
        # Discovery's `path` is relative to servicePath for some APIs and absolute for
        # others; shape() drops the version prefix either way, so both normalise alike.

        helpers = helper_paths(tree)
        api_base = ""
        m = re.search(r'^API\s*=\s*"([^"]+)"', src, re.M)
        if m:
            api_base = m.group(1).split("googleapis.com", 1)[-1]

        fns = tool_functions(tree)
        print(f"\n### {mod}  ->  {api} {ver}   "
              f"({len(fns)} tools vs {len(methods)} Discovery methods)")

        for fn in fns:
            verdict, matched, signals = classify(fn, src, api_base, helpers, shapes, api, methods)
            totals[verdict] += 1
            rows.append((mod, fn.__dict__["name"], verdict, matched, signals))
            mark = {"generic": "ok  ", "composite": "chain", "assembly": "HAND", "unmatched": "?   "}[verdict]
            extra = ""
            if VERBOSE and matched:
                extra = "  <- " + ", ".join(matched[:3]) + ("..." if len(matched) > 3 else "")
            if signals:
                extra += "  [" + ", ".join(signals[:3]) + "]"
            print(f"  {mark}  {fn.__dict__['name']:34s} {verdict}{extra}")

    n = sum(totals.values())
    if not n:
        print("no tools found -- module layout changed?")
        return 1

    print("\n" + "=" * 70)
    print(f"{n} Google tools across {len(MODULES)} hand-written modules\n")
    for k in ("generic", "composite", "assembly", "unmatched"):
        pct = 100.0 * totals[k] / n
        bar = "#" * int(pct / 2.5)
        print(f"  {k:10s} {totals[k]:3d}  {pct:5.1f}%  {bar}")

    replaceable = totals["generic"] + totals["composite"]
    print(f"\n  a Discovery-driven builder could emit >= {replaceable}/{n} "
          f"({100.0 * replaceable / n:.0f}%) of these")
    print(f"  {totals['assembly']} must stay hand-written (payload assembly)")
    if totals["unmatched"]:
        print(f"  {totals['unmatched']} unmatched -- NOT proven unsupportable, see below")
        print("\n  Read the number as a FLOOR, not a ceiling. The unmatched tools call\n"
              "  resource-name-addressed methods (`v1/{+name}`), which normalise to a bare\n"
              "  wildcard and so cannot be matched by path shape at all. A generic builder\n"
              "  handles them fine -- this probe just cannot PROVE it, so they are left\n"
              "  uncounted rather than quietly scored as wins.")

    hand = [f"{m}:{f}" for m, f, v, _, _ in rows if v == "assembly"]
    if hand:
        print("\n  must stay hand-written:")
        for h in hand:
            print(f"    - {h}")
    unm = [f"{m}:{f}" for m, f, v, _, _ in rows if v == "unmatched"]
    if unm and not VERBOSE:
        print(f"\n  unmatched ({len(unm)}): " + ", ".join(unm[:8]) + ("..." if len(unm) > 8 else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
