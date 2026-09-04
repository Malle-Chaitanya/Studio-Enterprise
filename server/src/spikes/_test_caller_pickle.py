"""Does the per-user caller channel survive cloudpickle?

This is the exact failure that broke every ADK deploy on 2026-08-24: Vertex pickles the
agent, adk_deploy.py runs as __main__ so tool closures serialise BY VALUE, and a
module-level ContextVar in that graph raised
  TypeError: cannot pickle '_contextvars.ContextVar' object
which fell back to low-code create and produced PRIVATE, unshared agents. Reasoning about
it is what got us there; this reproduces it instead.

Run:  cd server && python src/spikes/_test_caller_pickle.py
"""
import asyncio
import importlib.util
import pathlib
import sys

import cloudpickle

HERE = pathlib.Path(__file__).resolve()
ADK = HERE.parents[2] / "scripts" / "adk_deploy.py"

# Load adk_deploy.py as __main__ -- the name it has when Vertex pickles it. Under any other
# name cloudpickle serialises its functions BY REFERENCE and the test passes vacuously.
spec = importlib.util.spec_from_file_location("__main__", ADK)
mod = importlib.util.module_from_spec(spec)
sys.modules["_adk_under_test"] = mod
try:
    spec.loader.exec_module(mod)
except SystemExit:
    pass

fails = []


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + ((" -- " + detail) if detail else ""))
    if not ok:
        fails.append(name)


# 1. The holder must be EMPTY after import. A populated one means something armed the
#    ContextVar at build time and the pickle would carry it.
check("holder empty after import", mod._CALLER_HOLDER == {}, repr(mod._CALLER_HOLDER))
check("unarmed guard passes", (mod._assert_caller_channel_unarmed() or True))


# 2. A wrapped tool closing over the caller channel must pickle.
def sample_tool(query: str) -> dict:
    """Look something up."""
    return {"q": query, "caller": mod._caller_var().get("")}


wrapped = mod._bind_caller(sample_tool)
try:
    blob = cloudpickle.dumps(wrapped)
    check("wrapped tool pickles", True, f"{len(blob)} bytes")
except Exception as e:  # noqa: BLE001
    check("wrapped tool pickles", False, f"{type(e).__name__}: {e}")
    blob = None

# 3. Arming it must NOT break pickling either -- the container arms it on the first call,
#    and Vertex can re-pickle. (Also proves the guard is about build time, not correctness.)
mod._caller_var()
check("holder armed after use", "var" in mod._CALLER_HOLDER)


def _guard_refuses():
    try:
        mod._assert_caller_channel_unarmed()
        return False
    except RuntimeError:
        return True


check("guard refuses once armed", _guard_refuses())
mod._CALLER_HOLDER.clear()

# 4. Signature: ADK injects tool_context only if the signature declares it, and must NOT
#    show it to the model as an argument.
import inspect  # noqa: E402

sig = inspect.signature(wrapped)
check("tool_context in signature", "tool_context" in sig.parameters)
check("original params kept", "query" in sig.parameters)
check("name preserved", wrapped.__name__ == "sample_tool", wrapped.__name__)

# 5. The caller is visible during the call and gone after -- no bleed between callers.


class _Ctx:
    def __init__(self, uid):
        self.state = {"_caller_user_id": uid}


r1 = wrapped("a", tool_context=_Ctx("zara@storefuze.com"))
check("caller visible during call", r1["caller"] == "zara@storefuze.com", repr(r1))
check("caller cleared after call", mod._caller_var().get("") == "")

r2 = wrapped("b", tool_context=_Ctx("erik@filefuze.co"))
check("second caller not stale", r2["caller"] == "erik@filefuze.co", repr(r2))

r3 = wrapped("c", tool_context=None)
check("unknown caller is empty, never shared", r3["caller"] == "")


# 6. Concurrency: two callers in flight on one event loop must not see each other.
async def _race():
    async def one(uid, delay):
        def _inner(q: str) -> dict:
            return {"caller": mod._caller_var().get("")}

        w = mod._bind_caller(_inner)
        await asyncio.sleep(delay)
        return w("x", tool_context=_Ctx(uid))["caller"]

    return await asyncio.gather(one("a@x.com", 0.02), one("b@x.com", 0.01))


got = asyncio.run(_race())
check("concurrent callers isolated", got == ["a@x.com", "b@x.com"], repr(got))

# 7. NEGATIVE CONTROL. The rejected design -- a module-level ContextVar reachable from a
#    tool closure -- must still fail to pickle. Without this the suite could pass because
#    cloudpickle changed, not because the design is sound.
import contextvars  # noqa: E402

_BAD = contextvars.ContextVar("bad", default="")


def _bad_tool(q: str) -> str:
    return _BAD.get("")


try:
    cloudpickle.dumps(_bad_tool)
    check("negative control: module ContextVar still unpicklable", False,
          "it pickled -- this suite no longer proves anything")
except TypeError as e:
    check("negative control: module ContextVar still unpicklable", True, str(e)[:60])

print()
print("FAILURES: " + (", ".join(fails) if fails else "none"))
sys.exit(1 if fails else 0)
