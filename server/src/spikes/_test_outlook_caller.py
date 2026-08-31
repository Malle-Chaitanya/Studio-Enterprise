"""Does a per-user Outlook tool read the CALLER's mailbox, and refuse when it cannot?

The failure this guards is silent: falling back to the configured mailbox would answer
Alex's "what is in my inbox" with somebody else's mail, and the reply would look normal.

Run:  cd server && python src/spikes/_test_outlook_caller.py
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "scripts"))
from connector_tools import outlook  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + ((" -- " + detail) if detail else ""))
    if not ok:
        fails.append(name)


CALLER = {"v": ""}
secrets = {"impersonate_email": "shared-inbox@filefuze.co"}


def make(conn):
    """build_tools, capturing the module's own _mailbox via a tool's reported identity."""
    return outlook.build_tools(
        conn,
        lambda f: secrets[f],
        lambda fill: "token",
        lambda fill: "Bearer token",
        lambda t: t,
        caller=lambda: CALLER["v"],
    )


PER_USER = {"name": "Outlook", "kind": "outlook", "perUser": True, "perUserMode": "impersonate"}
SHARED = {"name": "Outlook", "kind": "outlook"}

# The tools close over _mailbox; reach it through the module's own closure cells rather than
# calling Graph. Any tool works -- they all resolve the mailbox the same way.
def mailbox_of(tools, caller_value):
    CALLER["v"] = caller_value
    fn = tools[0] if isinstance(tools, (list, tuple)) else tools
    for cell in (fn.__closure__ or []):
        v = cell.cell_contents
        if callable(v) and getattr(v, "__name__", "") == "_mailbox":
            return v()
    raise AssertionError("could not reach _mailbox")


# 1. Per-user: the caller's own mailbox, never the configured one.
try:
    got = mailbox_of(make(PER_USER), "alex@filefuze.co")
    check("per-user reads the caller's mailbox", got == "alex@filefuze.co", got)
except Exception as e:  # noqa: BLE001
    check("per-user reads the caller's mailbox", False, f"{type(e).__name__}: {e}")

# 2. A different caller gets a different mailbox -- no stale identity between calls.
try:
    got = mailbox_of(make(PER_USER), "erik@filefuze.co")
    check("second caller is not the first", got == "erik@filefuze.co", got)
except Exception as e:  # noqa: BLE001
    check("second caller is not the first", False, f"{type(e).__name__}: {e}")

# 3. THE ONE THAT MATTERS: unknown caller must refuse, never fall back to the shared mailbox.
try:
    got = mailbox_of(make(PER_USER), "")
    check("unknown caller refuses", False, f"returned {got!r} instead of raising")
except RuntimeError as e:
    check("unknown caller refuses", "could not be identified" in str(e), str(e)[:80])
except Exception as e:  # noqa: BLE001
    check("unknown caller refuses", False, f"{type(e).__name__}: {e}")

# 4. Shared (`maker`) connectors are untouched -- still the configured mailbox.
try:
    got = mailbox_of(make(SHARED), "alex@filefuze.co")
    check("shared connector keeps its configured mailbox", got == "shared-inbox@filefuze.co", got)
except Exception as e:  # noqa: BLE001
    check("shared connector keeps its configured mailbox", False, f"{type(e).__name__}: {e}")

print()
print("FAILURES: " + (", ".join(fails) if fails else "none"))
sys.exit(1 if fails else 0)
