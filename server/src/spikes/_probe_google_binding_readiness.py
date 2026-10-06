"""Decide, per Google connector, whether a generated VENDOR_BINDINGS row would produce a
tool that WORKS -- or one that deploys green and 404s.

WHY THIS EXISTS. googleCatalog.ts already holds a baseUrlTemplate for every Google app, and
VENDOR_BINDINGS needs the same URL as `baseUrl`. Copying one into the other is a two-line
change and it is NOT safe, for one measured reason:

    shared_googlecontacts   verdict vendor-path, proxyRatio 0%, every automated check PASSES
                            paths: /m8/feeds/contacts/default/full
                            that is GData. Google retired it in 2022.

A connector whose swagger is immaculate and whose API is gone is the worst shape of failure
this pipeline can ship: the readiness report says ready, the deploy succeeds, and every call
fails at inference with a vendor error no customer can trace back to us. Today that connector
is honestly unbound. Binding it without this check makes it confidently wrong, which is worse
than unsupported.

WHAT IT CHECKS. Google publishes, for every live API, a Discovery document whose `baseUrl`
plus each method's `path` IS the full URL -- an invariant Google maintains, not a convention
this probe assumes. So "is this path real, under THIS base URL?" is answerable offline, with
no tenant, no credential and no live call:

    discovery baseUrl + method path      ->  full vendor URL
    minus the catalog's baseUrlTemplate  ->  the path a bound tool would call
    compared against the connector's own path

Joining on the FULL URL rather than the bare path is load-bearing, and the first run of this
probe is why. Google spells the two halves differently per API:

    tasks     baseUrl https://tasks.googleapis.com/            path tasks/v1/lists/{tasklist}/tasks
    calendar  baseUrl https://www.googleapis.com/calendar/v3/  path calendars/{calendarId}/events
    people    baseUrl https://people.googleapis.com/           path v1/people:createContact

Comparing bare paths therefore refused shared_googletasks -- the one Google connector that
WORKS IN PRODUCTION TODAY on the generic path. A gate that blocks working work is worse than
no gate, and the failure would have been invisible: the verdict read "live API, no path
match", which is exactly what a genuinely dead connector looks like. Joining on the full URL
removes the guess, and validates the base URL at the same time: a baseUrlTemplate that
prefixes no Discovery URL at all is simply wrong.

VERDICTS
    bindable        paths resolve against the live API under this exact base URL.
    proxy-only      paths are Microsoft's dataset abstraction. No row fixes this.
    dead-api        the API is not in Discovery. REFUSE.
    bad-base-url    API is live, but the catalog's baseUrl prefixes none of its URLs.
    no-path-match   API and base URL are right; none of the connector's paths exist. REFUSE.
    no-catalog-row  not in googleCatalog.ts, so there is no base URL to generate from.

    cd server && python src/spikes/_probe_google_binding_readiness.py
    cd server && python src/spikes/_probe_google_binding_readiness.py --json

Read-only. Uses the Discovery documents cached by _probe_name_to_api_call.py (run that first);
fetches nothing itself and needs no credential.
"""
import argparse, io, json, pathlib, re, sys, tempfile

CACHE = pathlib.Path(tempfile.gettempdir()) / "csge_discovery_cache"
REPO = pathlib.Path(__file__).resolve().parents[3]
INDEX = REPO / "docs" / "connector-api-index.json"
CATALOG = REPO / "server" / "src" / "connectors" / "googleCatalog.ts"

# Microsoft's table abstraction. Lifted from operationBinding.ts's shared_googledrive /
# shared_googlesheet entries -- if these ever diverge the two files disagree about the same
# connector, which is the duplicated-fact bug this whole probe exists to avoid.
PROXY_MARKERS = (r"/\$metadata\.json", r"/datasets?\b", r"/tables?\b")


def load_catalog() -> dict:
    """connectorId -> {api, baseUrl, scope} from the GENERATED catalog.

    Parsed rather than imported because the catalog is TypeScript and this is a Python
    probe. Fields are read by NAME, so a reordering of the generator's output cannot
    silently shift a base URL onto the wrong app.
    """
    if not CATALOG.exists():
        sys.exit(f"missing {CATALOG}")
    text = io.open(CATALOG, encoding="utf-8").read()
    rows = {}
    for block in re.findall(r"\{([^{}]*?id:\s*'shared_[^{}]*?)\}", text, re.S):
        def field(name, b=None):
            m = re.search(name + r":\s*'([^']*)'", b if b is not None else block)
            return m.group(1) if m else ""
        cid = field("id")
        if cid:
            rows[cid] = {"api": field("api"), "baseUrl": field("baseUrlTemplate"), "scope": field("scope")}
    return rows


def discovery_urls(api: str) -> list | None:
    """Every FULL method URL the API declares, or None when the API is not in Discovery.

    `baseUrl` + `path` is the full URL by Discovery's own contract, and only the full URL is
    comparable across APIs -- see the module docstring for the three spellings that made
    bare-path comparison refuse a working connector.

    Walks `resources` recursively: Discovery nests them (drive.files.list,
    gmail.users.messages.get), and a flat read of the top level finds almost nothing.
    """
    doc = CACHE / f"{api}.json"
    if not doc.exists():
        return None
    data = json.loads(io.open(doc, encoding="utf-8").read())
    base = (data.get("baseUrl") or data.get("rootUrl") or "").rstrip("/")
    out = []

    def walk(node):
        for m in (node.get("methods") or {}).values():
            # flatPath spells out a path the templated `path` collapses, so prefer it where
            # both exist -- `{+name}` and `v1/{name=projects/*/x}` match different things.
            path = m.get("flatPath") or m.get("path") or ""
            if path:
                out.append(base + "/" + path.lstrip("/"))
        for sub in (node.get("resources") or {}).values():
            walk(sub)

    walk(data)
    return out


def segments(path: str) -> list:
    """`/calendars/{calendarId}/events` -> ['calendars', '{}', 'events'].

    Every placeholder collapses to `{}` so a connector's `{calendarId}` and Discovery's
    `{+name}` compare equal, and a trailing `:generateContent` stays attached to its segment
    because it selects a different method.
    """
    p = re.sub(r"\{[^}]*\}", "{}", path.strip("/"))
    return [s for s in p.split("/") if s]


def matches(conn: list, disco: list) -> bool:
    """One connector path against one Discovery path, placeholders wild on EITHER side.

    A Discovery placeholder matches any connector segment -- that is what a path parameter
    is. A connector placeholder matching a Discovery LITERAL is also allowed, because Power
    Platform parameterises things Google hardcodes (`{apiVersion}` where Discovery writes
    `v1`), and refusing that would read as a dead API rather than a parameterised version.
    """
    if len(conn) != len(disco):
        return False
    for c, d in zip(conn, disco):
        if c == "{}" or d == "{}":
            continue
        if c.lower() != d.lower():
            return False
    return True


def classify(cid: str, paths: list, cat: dict) -> dict:
    row = cat.get(cid)
    if any(re.search(m, p) for p in paths for m in PROXY_MARKERS):
        return {"verdict": "proxy-only", "detail": "paths are the Power Platform dataset abstraction"}
    if not row:
        return {"verdict": "no-catalog-row", "detail": "not in googleCatalog.ts - no base URL to generate from"}

    urls = discovery_urls(row["api"])
    if urls is None:
        return {
            "verdict": "dead-api",
            "detail": "'" + row["api"] + "' is not in Google's Discovery service - the API "
                      "this connector targets no longer exists",
        }

    # The base URL is VALIDATED here, not assumed: keep only the Discovery URLs this
    # baseUrlTemplate actually prefixes, and what remains is exactly the set of paths a tool
    # built on that base could reach. An empty set means the base URL is wrong, which is a
    # different failure from a dead API and is reported as one.
    base = row["baseUrl"].rstrip("/")
    reachable = [u[len(base):] for u in urls if u.startswith(base + "/")]
    if not reachable:
        return {
            "verdict": "bad-base-url",
            "detail": "'" + row["api"] + "' is live but baseUrl '" + base + "' prefixes none "
                      "of its " + str(len(urls)) + " method URLs",
        }

    dsegs = [segments(p) for p in reachable]
    hit, miss = [], []
    for p in paths:
        (hit if any(matches(segments(p), d) for d in dsegs) else miss).append(p)

    if hit and not miss:
        return {
            "verdict": "bindable",
            "detail": str(len(hit)) + "/" + str(len(paths)) + " sample paths resolve under "
                      + base + " (" + str(len(reachable)) + " reachable methods)",
        }
    if hit:
        return {"verdict": "partial", "detail": str(len(hit)) + " resolve, " + str(len(miss)) + " do not: " + str(miss)}
    return {
        "verdict": "no-path-match",
        "detail": "'" + row["api"] + "' is live and baseUrl '" + base + "' is right, but none "
                  "of " + str(paths) + " is one of its " + str(len(reachable)) + " reachable method paths",
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    if not CACHE.exists():
        sys.exit("no Discovery cache at " + str(CACHE) + " - run _probe_name_to_api_call.py first")
    if not INDEX.exists():
        sys.exit("missing " + str(INDEX) + " - run _probe_connector_api_index.ts first")

    cat = load_catalog()
    rows = json.loads(io.open(INDEX, encoding="utf-8").read())["rows"]
    google = sorted(
        [r for r in rows if re.search(r"google|gmail", r["connectorId"], re.I)],
        key=lambda r: -r["operationCount"],
    )

    results = []
    for r in google:
        verdict = classify(r["connectorId"], r.get("samplePaths") or [], cat)
        results.append({
            "connectorId": r["connectorId"],
            "ops": r["operationCount"],
            "indexVerdict": r["verdict"],
            "api": cat.get(r["connectorId"], {}).get("api", ""),
            "baseUrl": cat.get(r["connectorId"], {}).get("baseUrl", ""),
            **verdict,
        })

    if args.json:
        print(json.dumps(results, indent=1))
        return 0

    total = sum(r["ops"] for r in results)
    print(str(len(results)) + " Google connectors in the Copilot catalog, " + str(total) + " operations\n")
    print("connector".ljust(30) + "ops".rjust(4) + "  " + "index".ljust(12) + "binding verdict".ljust(16) + "api")
    print("-" * 96)
    for r in results:
        print(r["connectorId"].ljust(30) + str(r["ops"]).rjust(4) + "  "
              + r["indexVerdict"].ljust(12) + r["verdict"].ljust(16) + (r["api"] or "-"))
    print()
    for r in results:
        print("  " + r["connectorId"] + ": " + r["detail"])

    safe = [r for r in results if r["verdict"] == "bindable"]
    refused = [r for r in results if r["verdict"] in ("dead-api", "no-path-match", "bad-base-url")]
    print("\nSAFE TO GENERATE NOW: " + str(len(safe)) + " connector(s), "
          + str(sum(r["ops"] for r in safe)) + " operations - "
          + (", ".join(r["connectorId"] for r in safe) or "none"))
    print("REFUSED BY THIS GATE: " + str(len(refused)) + " connector(s) - "
          + (", ".join(r["connectorId"] for r in refused) or "none"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
