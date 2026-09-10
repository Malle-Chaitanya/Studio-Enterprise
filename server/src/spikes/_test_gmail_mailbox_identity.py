"""gmail.build_tools must report the CALLER's mailbox when it impersonates, not the pinned
secret. AST-level so it runs without google deps or a live tenant.

Guards the honesty bug found 2026-09-09: the DWD subject follows the caller, so the tools
read the caller's mail, while every response still named `impersonate_email` -- telling a
person their own inbox belonged to someone else.
"""
import ast
import io
import pathlib
import sys

SRC = pathlib.Path(__file__).resolve().parents[2] / "scripts" / "connector_tools" / "gmail.py"
tree = ast.parse(io.open(SRC, encoding="utf-8").read())

fails = []

build = next((n for n in ast.walk(tree)
              if isinstance(n, ast.FunctionDef) and n.name == "build_tools"), None)
if build is None:
    fails.append("build_tools not found")
else:
    args = [a.arg for a in build.args.args]
    if "caller" not in args:
        fails.append(f"build_tools must accept `caller`; got {args}")

mailbox = next((n for n in ast.walk(tree)
                if isinstance(n, ast.FunctionDef) and n.name == "_mailbox"), None)
if mailbox is None:
    fails.append("_mailbox not found")
else:
    body = ast.dump(mailbox)
    if "caller" not in body:
        fails.append("_mailbox never consults caller() — reports the pinned mailbox to every caller")
    if "impersonate_email" not in body:
        fails.append("_mailbox lost its maker-mode fallback to impersonate_email")
    # The caller branch must come FIRST; a fallback that runs first is the bug itself.
    first = ast.dump(mailbox.body[1]) if len(mailbox.body) > 1 else ""
    if "impersonate_email" in first:
        fails.append("_mailbox checks impersonate_email before caller() — wrong precedence")

# Write tools must still be exported; a regression to read-only would silently drop send.
names = {n.name for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)}
for required in ("gmail_send_message", "gmail_reply_to_message", "gmail_forward_message"):
    if required not in names:
        fails.append(f"missing write tool {required}")

if fails:
    print("FAIL")
    for f in fails:
        print("  - " + f)
    sys.exit(1)
print("PASS: gmail reports the impersonated caller's mailbox, write tools intact")
