"""Send tools must not claim DELIVERY -- only that the provider accepted the message.

Graph's sendMail and Gmail's messages.send both answer "accepted", not "delivered". A
bounce (a recipient-rate limit, an unknown address) arrives later as a message in the
mailbox, so the send call cannot see it. Observed live 2026-09-09: a migrated agent
answered "OK, I've sent the email" while five Undeliverable bounces for that exact send
were already landing. `sent: True` there is a delivery claim the code cannot back.
"""
import ast
import io
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2] / "scripts" / "connector_tools"
failures = []


def returned_keys(path):
    """Every dict-literal key returned by any function in the module."""
    tree = ast.parse(io.open(path, encoding="utf-8").read())
    keys = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Return) and isinstance(node.value, ast.Dict):
            for k in node.value.keys:
                if isinstance(k, ast.Constant) and isinstance(k.value, str):
                    keys.add(k.value)
    return keys


for mod in ("outlook.py", "gmail.py"):
    path = ROOT / mod
    keys = returned_keys(path)
    src = io.open(path, encoding="utf-8").read()

    if "sent" in keys:
        failures.append(f"{mod}: still returns a `sent` key -- that claims delivery")
    else:
        print(f"PASS {mod}: no `sent` delivery claim")

    if "queued" not in keys:
        failures.append(f"{mod}: no `queued` key -- send result must say what actually happened")
    else:
        print(f"PASS {mod}: reports `queued`")

    if "_DELIVERY_NOTE" not in src:
        failures.append(f"{mod}: no _DELIVERY_NOTE for the model to read")
    else:
        print(f"PASS {mod}: carries the delivery caveat")

    # The caveat is only useful if it actually warns.
    if "_DELIVERY_NOTE" in src and "not confirmation of delivery" not in src:
        failures.append(f"{mod}: _DELIVERY_NOTE does not say it is not a delivery confirmation")

# chat.py is deliberately exempt: posting to a Chat space either succeeds or errors,
# there is no out-of-band bounce, so its `sent` is a claim it can actually back.
chat_keys = returned_keys(ROOT / "chat.py")
if "sent" in chat_keys:
    print("PASS chat.py: `sent` kept -- Chat delivery is synchronous, no bounce concept")

print()
if failures:
    print("FAILURES:")
    for f in failures:
        print("  -", f)
    sys.exit(1)
print("FAILURES: none")
