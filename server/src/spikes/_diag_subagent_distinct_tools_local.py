"""Sanity check: can a sub-agent have its OWN distinct tool — different from
its parent's — and does the runtime actually CALL that tool (not just recite
its instruction) when the parent delegates to it?

This is the direct follow-up to _diag_adk_subagent_sanity.ts (which proved
sub_agents delegation itself works against a real deployed WorkMate copy) and
to this session's official-docs research, which found no framework-level
restriction against heterogeneous tools across a sub-agent tree — Google's own
"Agent team" tutorial does exactly this (root + greeting_agent + farewell_agent,
each with a different tool). What was actually missing was OUR OWN
adk_deploy.py, which only supports "sub-agent inherits ALL of the root's
tools, or none" (see AdkSpec.subAgents / adk_deploy.py's sub_agent_specs loop)
— there is no per-sub-agent tool list in our pipeline today.

Runs entirely locally via InMemoryRunner — no Vertex AI Reasoning Engine
deployment, no billing. Deployment PACKAGING of a sub_agents tree was already
proven separately (_diag_adk_subagent_sanity.ts, live, 2026-08-31); this script
isolates the one remaining unproven question: does per-agent tool wiring
actually work, at the ADK tree-construction/execution level.

Root's instruction is WorkMate's REAL captured description (from the earlier
live sanity run's log output), so this isn't testing a bare synthetic agent —
same spirit as reusing WorkMate's real content for the delegation check.

Two DISTINCT tools, one per agent, each returning an unmistakable marker
embedded in the TOOL'S RETURN VALUE (not just an instruction-injected prefix
like the first sanity check used) — stronger proof, because a marker in a
function's return value can only appear in the final answer if that function
was actually CALLED and its result was actually used, not merely narrated.

Requires: pip install google-adk, and GOOGLE_API_KEY (or Vertex ADC via
GOOGLE_APPLICATION_CREDENTIALS + GOOGLE_GENAI_USE_VERTEXAI=1) in the
environment — same as the local A2A sanity scripts.

Run: python server/src/spikes/_diag_subagent_distinct_tools_local.py
"""
import asyncio

from google.adk.agents import Agent
from google.adk.runners import InMemoryRunner
from google.adk.tools import FunctionTool
from google.genai import types

ROOT_MARKER = "ROOT_TOOL_5RKT_CALLED"
SUBAGENT_MARKER = "SUBAGENT_TOOL_9YXZ_CALLED"

# WorkMate's real description, captured verbatim from the 2026-08-31 live
# sanity-check deploy log (server/src/spikes/_diag_adk_subagent_sanity.ts run) —
# not hand-typed, so the root's own identity in this test matches the real
# migrated agent's actual framing.
WORKMATE_DESCRIPTION = (
    "WorkMate is your universal enterprise AI assistant. It finds company "
    "information fast, manages scheduling, and resolves everyday admin tasks "
    "by connecting to Microsoft Teams, Google Drive, HubSpot, Confluence, and "
    "Jira. It searches knowledge sources for instant answers, looks up people "
    "and calendars, and can check or create support tickets - all while "
    "respecting your organization's data permissions."
)


def list_connected_systems() -> dict:
    """List the systems this assistant is directly connected to.

    Returns:
      A dict naming the connected systems, with a call-proof marker.
    """
    return {
        "marker": ROOT_MARKER,
        "systems": ["Microsoft Teams", "Google Drive", "HubSpot", "Confluence", "Jira"],
    }


def lookup_invoice_status(invoice_id: str) -> dict:
    """Look up the status of a billing invoice by its ID.

    Args:
      invoice_id: The invoice ID to look up. Guess a reasonable placeholder
        like "INV-0001" if the user did not give one.

    Returns:
      A dict with the invoice's status, a refund ETA, and a call-proof marker.
    """
    return {
        "marker": SUBAGENT_MARKER,
        "invoice_id": invoice_id,
        "status": "duplicate_charge_confirmed",
        "refund_eta_days": 3,
    }


billing_expert = Agent(
    name="billing_expert",
    model="gemini-2.5-flash",
    description=(
        "Handles ALL billing, invoice, payment, and refund questions. Use this "
        "whenever the user asks about billing, invoices, payments, charges, or refunds."
    ),
    instruction=(
        "You are a billing expert sub-agent, with your OWN tool the root agent does not "
        "have. For ANY billing/invoice question, you MUST call lookup_invoice_status "
        "(guess a placeholder invoice id if none was given) and report the exact status "
        "and marker value it returns, verbatim, in your answer."
    ),
    tools=[FunctionTool(lookup_invoice_status)],
)

root_agent = Agent(
    name="workmate_distinct_tools_sanity",
    model="gemini-2.5-flash",
    description=WORKMATE_DESCRIPTION,
    instruction=(
        f"You are Meridian, the universal enterprise assistant. {WORKMATE_DESCRIPTION} "
        "You know nothing about billing or invoices — for ANY billing/invoice/payment/"
        "refund question, delegate entirely to your billing_expert sub-agent; never "
        "answer a billing question yourself. When asked what systems you are connected "
        "to, call your own list_connected_systems tool and report its result verbatim."
    ),
    tools=[FunctionTool(list_connected_systems)],
    sub_agents=[billing_expert],
)


async def probe(runner: InMemoryRunner, session_id: str, user_id: str, message: str) -> str:
    content = types.Content(role="user", parts=[types.Part(text=message)])
    reply_text = ""
    async for event in runner.run_async(user_id=user_id, session_id=session_id, new_message=content):
        if event.content and event.content.parts:
            for part in event.content.parts:
                if getattr(part, "text", None):
                    reply_text += part.text
    return reply_text


async def main():
    runner = InMemoryRunner(agent=root_agent, app_name="distinct_tools_sanity")
    user_id = "cf-distinct-tools-sanity"

    probes = [
        (
            "billing question -> should call the SUB-AGENT's OWN tool",
            "Why was I charged twice on my last invoice?",
            SUBAGENT_MARKER,
            ROOT_MARKER,
        ),
        (
            "root's own question -> should call the ROOT's OWN tool",
            "What systems are you connected to?",
            ROOT_MARKER,
            SUBAGENT_MARKER,
        ),
        (
            "unrelated question -> should call NEITHER tool",
            "What is the capital of France?",
            None,
            None,
        ),
    ]

    for label, message, expect_marker, unexpected_marker in probes:
        session = await runner.session_service.create_session(app_name="distinct_tools_sanity", user_id=user_id)
        print(f"\n--- probe: {label} ---")
        print(f"> {message}")
        answer = await probe(runner, session.id, user_id, message)
        print(f"< {answer}")
        has_expected = expect_marker is not None and expect_marker in answer
        has_unexpected = unexpected_marker is not None and unexpected_marker in answer
        if expect_marker is None:
            verdict = "PASS" if not has_unexpected and ROOT_MARKER not in answer and SUBAGENT_MARKER not in answer else "FAIL"
        else:
            verdict = "PASS" if has_expected and not has_unexpected else "FAIL"
        print(f"  expected marker present: {has_expected} — wrong marker present: {has_unexpected} — {verdict}")


if __name__ == "__main__":
    asyncio.run(main())
