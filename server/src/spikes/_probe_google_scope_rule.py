"""Derive the domain-wide-delegation scope for a Google app, and check the rule against the
four a human already chose.

WHY A RULE AND NOT A GUESS. _gen_google_catalog.ts deliberately refuses to generate `scope`,
because the obvious derivations are all wrong in the dangerous direction. Picking "the scope
the most methods accept" gives Sheets, Docs, Slides and Forms
`https://www.googleapis.com/auth/drive` -- every file in the customer's Drive, to use a
spreadsheet. Picking the shortest string does the same thing for the same reason. Preferring
a scope declared ONLY by this api fails too: `auth/spreadsheets` is declared by three apis,
so Sheets falls through to `auth/drive` again, which then wins on string length.

THE RULE THAT WORKS. Group the api's declared scopes by FAMILY (the first dotted segment:
`spreadsheets`, `drive`, `gmail`). Score each family by how many OTHER apis declare its
scopes, and take the most specific family -- that is the one that belongs to this app rather
than one it merely borrows. Then take the BROADEST scope inside that family, because DWD
matches exactly and a read-only grant leaves every write failing at token-mint time, which
reads as a code bug rather than a missing grant.

    sheets  families: spreadsheets (avg 2.5 apis)  drive (avg 6.3)  -> spreadsheets
                      broadest in family           -> auth/spreadsheets

VALIDATION. Reproduces all four single-scope values a human chose, exactly:
    gmail -> gmail.modify   drive -> drive   calendar -> calendar   people -> contacts
It does NOT reproduce Chat, and should not: Chat needs TWO scopes (chat.messages +
chat.spaces) and the rule emits one. Chat stays a human decision, which the ledger explains
-- adding a scope nobody granted breaks the WHOLE token request, measured on RE
1580263741172219904.

A proposal, not an authority: a scope grants real access and the value it proposes is written
into the catalog by a person who agreed with it.

    cd server && python src/spikes/_probe_google_scope_rule.py
    cd server && python src/spikes/_probe_google_scope_rule.py --api sheets

Read-only. Uses the Discovery documents cached by _probe_name_to_api_call.py (run that first
to build the scope index); fetches nothing itself and needs no credential.
"""
import argparse, collections, io, json, pathlib, re, sys, tempfile

CACHE = pathlib.Path(tempfile.gettempdir()) / "csge_discovery_cache"
APPS = ["gmail", "drive", "calendar", "people", "chat", "sheets", "docs", "slides", "tasks", "forms"]

# What a human chose, for the rule to be judged against. Chat is two scopes on purpose.
CHOSEN = {
    "gmail": "https://www.googleapis.com/auth/gmail.modify",
    "drive": "https://www.googleapis.com/auth/drive",
    "calendar": "https://www.googleapis.com/auth/calendar",
    "people": "https://www.googleapis.com/auth/contacts",
}


def load(name: str) -> dict:
    p = CACHE / f"{name}.json"
    if not p.exists():
        raise SystemExit(f"no cached {name}.json -- run _probe_name_to_api_call.py first")
    return json.loads(io.open(p, encoding="utf-8").read())


def propose(api: str, scope_index: dict) -> str | None:
    doc = load(api)
    declared = list(((doc.get("auth") or {}).get("oauth2") or {}).get("scopes") or {})
    if not declared:
        return None
    coverage: collections.Counter = collections.Counter()

    def walk(node):
        for res in (node.get("resources") or {}).values():
            for m in (res.get("methods") or {}).values():
                for s in m.get("scopes") or []:
                    coverage[s] += 1
            walk(res)

    walk(doc)

    families = collections.defaultdict(list)
    for s in declared:
        m = re.search(r"/auth/([^/]+)$", s)
        if m:  # skips https://mail.google.com/, which has no /auth/ segment
            families[m.group(1).split(".")[0]].append(s)
    if not families:
        return None

    def borrowed(fam: str) -> float:
        """Mean number of apis declaring this family's scopes. Lower = more this app's own."""
        return sum(len(scope_index.get(s.rstrip("/"), [])) for s in families[fam]) / len(families[fam])

    own = min(families, key=lambda f: (borrowed(f), f))
    return sorted(
        families[own],
        key=lambda s: (re.search(r"/auth/(.+)$", s).group(1).count("."), -coverage[s], len(s)),
    )[0]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", help="one api instead of all")
    a = ap.parse_args()

    idx_path = CACHE / "_scope_index.json"
    if not idx_path.exists():
        raise SystemExit("no cached scope index -- run _probe_name_to_api_call.py first")
    scope_index = json.loads(io.open(idx_path, encoding="utf-8").read())

    apps = [a.api] if a.api else APPS
    print(f"{'api':10s} {'proposed scope':52s} checked against the human choice")
    print("-" * 104)
    agree = differ = 0
    for api in apps:
        p = propose(api, scope_index)
        chosen = CHOSEN.get(api)
        if api == "chat":
            note = "NOT reproducible — Chat needs chat.messages + chat.spaces; the rule emits one scope"
        elif chosen is None:
            note = "new app — no human choice to check against"
        elif p == chosen:
            note = "matches"
            agree += 1
        else:
            note = f"DIFFERS — human chose {chosen}"
            differ += 1
        print(f"{api:10s} {str(p)[:51]:52s} {note}")
    print(f"\nreproduces {agree} of {agree + differ} single-scope human choices.")
    print("A scope grants real access, so this is a PROPOSAL. It belongs in googleCatalog.ts")
    print("only once a person has agreed with it.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
