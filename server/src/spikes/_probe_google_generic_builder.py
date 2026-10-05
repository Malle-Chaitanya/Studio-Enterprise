"""Generate ADK tools for a Google app from its Discovery document, with no per-app code.

THE CLAIM THIS TESTS. Today every Google app has a hand-written module in
scripts/connector_tools/ -- five of them, ~3,200 lines, 51 tools. A new Google app needs a
sixth file. If a generic builder can emit the same tools from Google's own machine-readable
Discovery document, a new app needs index DATA instead, and the files go away.

_probe_google_discovery_coverage.py already measured the ceiling: >=43 of 51 tools (84%)
look reproducible, 3 must stay hand-written because the request body is a format Discovery
names but does not build. That probe read the EXISTING code. This one does the opposite --
it builds tools from Discovery and shows what actually comes out, which is the only way to
find out whether 84% was optimistic.

    cd server && python src/spikes/_probe_google_generic_builder.py
    cd server && python src/spikes/_probe_google_generic_builder.py --api gmail
    cd server && python src/spikes/_probe_google_generic_builder.py --api drive --show files.create

Read-only. Fetches the public Discovery doc (no auth) and builds request descriptors; it
never sends a request, so no credential is needed and nothing can be mutated.

The operation ids it is fed by default are the REAL ones the staged agents use -- Power
Platform names like `ListFolder`, not Google's `files.list`. Bridging those two vocabularies
is part of what has to work, so it is part of what is tested.
"""
import argparse
import io
import json
import pathlib
import re
import sys
import tempfile
import urllib.request

CACHE = pathlib.Path(tempfile.gettempdir()) / "csge_google_discovery"
CACHE.mkdir(exist_ok=True)

DISCOVERY = {
    "drive": "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest",
    "gmail": "https://gmail.googleapis.com/$discovery/rest?version=v1",
    "calendar": "https://calendar-json.googleapis.com/$discovery/rest?version=v3",
    "people": "https://people.googleapis.com/$discovery/rest?version=v1",
    "chat": "https://chat.googleapis.com/$discovery/rest?version=v1",
}

# The operations real staged agents actually use, in Power Platform's vocabulary.
# Measured from stagedAgents: 11 distinct Drive operations across 56-71 agents each.
REAL_OPS = {
    "drive": ["ListFolder", "ListRootFolder", "GetFileContent", "GetFileMetadata",
              "GetFileContentByPath", "GetFileMetadataByPath", "CreateFileV2",
              "UpdateFile", "CopyFile", "DeleteFile", "ExtractFolderV2"],
    "gmail": ["ListMessages", "GetMessage", "ListLabels", "SendEmailV2"],
    "calendar": ["ListEvents", "GetEvent", "CreateEvent", "DeleteEvent"],
    "people": ["ListContacts", "GetContact", "CreateContact"],
    "chat": ["ListSpaces", "ListMessages", "SendMessage"],
}

# Payload formats Discovery NAMES but does not BUILD. A generic tool can expose the field;
# it cannot assemble the bytes. These are the ones that must stay hand-written, and the
# builder has to say so rather than emit a tool that looks fine and fails in use.
ASSEMBLY_FIELDS = {
    "raw": "RFC 2822 message, base64url encoded -- needs MIME assembly (see gmail.py:_mime)",
    "media": "multipart/related upload -- needs body framing",
}

PY_TYPE = {"string": "str", "integer": "int", "boolean": "bool",
           "number": "float", "array": "list", "object": "dict"}
PY_DEFAULT = {"str": "''", "int": "0", "bool": "False", "float": "0.0",
              "list": "None", "dict": "None"}


def discovery(api: str) -> dict:
    path = CACHE / f"{api}.json"
    if path.exists():
        return json.loads(io.open(path, encoding="utf-8").read())
    with urllib.request.urlopen(DISCOVERY[api], timeout=30) as r:
        doc = json.loads(r.read().decode("utf-8"))
    io.open(path, "w", encoding="utf-8").write(json.dumps(doc))
    return doc


def flatten(doc: dict) -> dict:
    out = {}

    def walk(node, prefix=""):
        for rname, res in (node.get("resources") or {}).items():
            for mname, m in (res.get("methods") or {}).items():
                out[f"{prefix}{rname}.{mname}"] = m
            walk(res, f"{prefix}{rname}.")

    walk(doc)
    return out


VERB_MAP = {"list": "list", "get": "get", "create": "create", "delete": "delete",
            "update": "update", "copy": "copy", "extract": "create", "move": "update",
            "find": "list", "search": "list", "send": "send", "add": "create"}


def resolve(op_id: str, methods: dict) -> str | None:
    """Power Platform operation id -> Discovery method name. Heuristic, and reported as one."""
    words = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", re.sub(r"V\d+$", "", op_id)).lower().split()
    if not words:
        return None
    verb = VERB_MAP.get(words[0])
    if not verb:
        return None
    nouns = {w.rstrip("s") for w in words[1:]}
    counts: dict = {}
    for name in methods:
        r = name.split(".")[-2] if "." in name else ""
        counts[r] = counts.get(r, 0) + 1
    dominant = max(counts, key=counts.get) if counts else ""

    best, best_score = None, -99.0
    for name, m in methods.items():
        parts = name.split(".")
        if parts[-1] != verb:
            continue
        score = 1.0
        if parts[-2].rstrip("s").lower() in nouns:
            score += 3
        if parts[-2] == dominant:
            score += 2
        score -= len(parts) * 0.1
        if score > best_score:
            best, best_score = name, score
    return best


def build_tool(name: str, m: dict, doc: dict) -> dict:
    """The tool a generic builder would emit for one Discovery method.

    Returns a descriptor rather than a live function: the point is to show the SIGNATURE
    and the request it would make, which is what decides whether this can replace a
    hand-written tool. Wiring it to urllib is the easy half and proves nothing.
    """
    params = dict(m.get("parameters") or {})
    # Discovery lists path/query params separately from the request BODY, which is a $ref
    # into `schemas`. The body is where the assembly problems live, so resolve it rather
    # than exposing an untyped `body: dict` the way the Microsoft path has to.
    body_ref = (m.get("request") or {}).get("$ref")
    body_fields, blockers = [], []

    # Media upload is declared on the METHOD, not in the body schema -- the first version of
    # this builder only inspected body properties and so reported 0 hand-written tools for
    # Drive, against the 3 that _probe_google_discovery_coverage.py found by reading the
    # existing code. Two probes disagreeing is the signal: this one was wrong, and wrong in
    # the flattering direction. `files.create` and `files.update` both carry
    # supportsMediaUpload with resumable/simple protocols, which a generic builder cannot
    # frame from the Discovery doc alone.
    if m.get("supportsMediaUpload"):
        protos = ", ".join((m.get("mediaUpload") or {}).get("protocols", {})) or "simple"
        blockers.append(("<media>", f"media upload ({protos}) -- needs multipart/resumable framing"))

    if body_ref:
        schema = (doc.get("schemas") or {}).get(body_ref, {})
        for fname, f in (schema.get("properties") or {}).items():
            if fname in ASSEMBLY_FIELDS:
                blockers.append((fname, ASSEMBLY_FIELDS[fname]))
            body_fields.append((fname, f.get("type", "object")))

    args = []
    for pname, p in sorted(params.items(), key=lambda kv: (not kv[1].get("required"), kv[0])):
        if p.get("location") == "path" and pname in ("userId", "calendarId"):
            continue  # supplied by impersonation, never asked of the model
        py = PY_TYPE.get(p.get("type", "string"), "str")
        args.append((re.sub(r"[^0-9a-zA-Z_]", "_", pname).strip("_") or "arg", py,
                     p.get("required", False), p.get("description", "")))
    if body_ref:
        args.append(("body", "dict", True, f"{body_ref} resource"))

    sig = ", ".join(
        f"{a}: {t}" + ("" if req else f" = {PY_DEFAULT[t]}")
        for a, t, req, _ in sorted(args, key=lambda x: not x[2])
    )
    return {
        "name": name, "python": f"{name.replace('.', '_')}({sig}) -> dict",
        "http": f"{m.get('httpMethod')} {m.get('path')}",
        "scopes": m.get("scopes") or [], "args": args,
        "body_ref": body_ref, "body_fields": body_fields, "blockers": blockers,
        "description": (m.get("description") or "").split(". ")[0][:110],
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="drive", choices=sorted(DISCOVERY))
    ap.add_argument("--show", help="print the full descriptor for one Discovery method")
    a = ap.parse_args()

    doc = discovery(a.api)
    methods = flatten(doc)
    ops = REAL_OPS.get(a.api, [])

    print(f"api={a.api}  discovery methods={len(methods)}  "
          f"real operations from staged agents={len(ops)}\n")

    built, unresolved, hand = [], [], []
    for op in ops:
        name = resolve(op, methods)
        if not name:
            unresolved.append(op)
            print(f"  {op:24s} -> (unresolved)")
            continue
        t = build_tool(name, methods[name], doc)
        (hand if t["blockers"] else built).append(t)
        flag = "  HAND-WRITTEN" if t["blockers"] else ""
        print(f"  {op:24s} -> {name}{flag}")

    print("\n" + "=" * 74)
    print("GENERATED TOOL SIGNATURES (what the model would see)\n")
    seen = set()
    for t in built:
        if t["name"] in seen:
            continue
        seen.add(t["name"])
        print(f"  {t['python']}")
        print(f"      {t['http']}")
        if t["description"]:
            print(f"      {t['description']}")
        print()

    if hand:
        print("=" * 74)
        print("MUST STAY HAND-WRITTEN\n")
        for t in hand:
            for f, why in t["blockers"]:
                print(f"  {t['name']}  field `{f}`")
                print(f"      {why}\n")

    if a.show:
        m = methods.get(a.show)
        if not m:
            print(f"no such method: {a.show}")
            return 1
        print("=" * 74)
        print(json.dumps(build_tool(a.show, m, doc), indent=2)[:2600])

    total = len(built) + len(hand) + len(unresolved)
    print("=" * 74)
    print(f"  generated   {len(built)}/{total}")
    print(f"  hand-written {len(hand)}/{total}")
    print(f"  unresolved  {len(unresolved)}/{total}"
          + (f"  ({', '.join(unresolved)})" if unresolved else ""))

    # DECLARATION BUDGET. Every parameter is tokens in the tool declaration the model reads
    # on every turn, and one more thing it can get wrong. Discovery lists a method's FULL
    # surface -- files.list carries corpora, corpus, teamDriveId, supportsTeamDrives and
    # other deprecated or Team-Drive-era parameters a hand-written tool simply never exposed.
    # Generated tools being correct is necessary; being usable is separate, and this is the
    # number that decides it. See the existing tool-declaration-budget spike.
    if built:
        widths = sorted((len(t["args"]), t["name"]) for t in built)
        avg = sum(w for w, _ in widths) / len(widths)
        print(f"\n  declaration budget: {avg:.1f} params/tool average, "
              f"widest {widths[-1][1]} at {widths[-1][0]}")
        print("  Hand-written tools expose far fewer. A generic builder that emits a "
              "method's\n  full parameter surface is correct and harder to use -- narrowing "
              "is a design\n  decision this probe deliberately does not make for you.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
