"""Sanity check, half 2 of 2: does a parent agent really delegate to a REMOTE
agent process over A2A (RemoteA2aAgent), the mechanism this session's research
identified as the Gemini-side equivalent of Copilot Studio's "connected agent"?

Prerequisite: _diag_a2a_sanity_agent_b_server.py must already be running in
another terminal (serves the billing sub-agent on http://localhost:8001).

This builds agent A with the remote billing agent wired in TWO ways so both
ADK primitives researched this session get exercised in one pass:
  1. as a `sub_agents` entry (LLM-driven auto-delegation / transfer of control)
  2. would also work via `AgentTool(RemoteA2aAgent(...))` (parent stays in
     control) — left as a commented alternative below; sub_agents is tried
     first since it is the documented equivalent of Copilot's "redirect to
     agent" + autonomous hand-off behavior.

Sends two probes exactly like the sub-agent sanity check (_diag_adk_subagent_
sanity.ts), so the two results are directly comparable:
  - a billing question (should show agent B's A2A_MARKER_9K2L in the reply)
  - a general question (should NOT show it — proves this isn't just always
    delegating everything)

No GCP deployment, no billable resources — everything runs as local
processes talking over localhost HTTP, using ADK's own Runner directly
(the same in-process invocation `adk run` uses under the hood) rather than
Vertex AI Reasoning Engine's stream_query wire format.

Run (after agent_b_server.py is already running in another terminal):
    python _diag_a2a_sanity_agent_a_test.py
"""
import asyncio

from google.adk.agents import Agent
from google.adk.agents.remote_a2a_agent import RemoteA2aAgent
from google.adk.runners import InMemoryRunner
from google.genai import types

MARKER = "A2A_MARKER_9K2L"
AGENT_B_CARD_URL = "http://localhost:8001/.well-known/agent.json"

remote_billing_agent = RemoteA2aAgent(
    name="billing_agent_b",
    agent_card=AGENT_B_CARD_URL,
    description="Handles ALL billing, invoice, payment, and refund questions.",
)

root_agent = Agent(
    name="sanity_root_a",
    model="gemini-2.5-flash",
    description="A general-purpose assistant with a remote billing specialist.",
    instruction=(
        "You are a general-purpose assistant. You know nothing about billing or "
        "invoices — for ANY billing/invoice/payment/refund question, you must "
        "delegate to your remote billing_agent_b sub-agent; never answer a "
        "billing question yourself."
    ),
    sub_agents=[remote_billing_agent],
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
    runner = InMemoryRunner(agent=root_agent, app_name="a2a_sanity")
    user_id = "cf-a2a-sanity"

    probes = [
        ("billing question (should delegate over A2A)", "Why was I charged twice on my last invoice?", True),
        ("general question (should NOT delegate)", "What is the capital of France?", False),
    ]

    for label, message, expect_marker in probes:
        session = await runner.session_service.create_session(app_name="a2a_sanity", user_id=user_id)
        print(f"\n--- probe: {label} ---")
        print(f"> {message}")
        try:
            answer = await probe(runner, session.id, user_id, message)
        except Exception as e:  # noqa: BLE001 — this IS the sanity check; a raised connection error is a real result
            print(f"FAILED (agent_b_server.py running on :8001?): {e}")
            continue
        print(f"< {answer}")
        has_marker = MARKER in answer
        verdict = "PASS" if has_marker == expect_marker else "FAIL"
        print(f"  marker present: {has_marker} (expected {expect_marker}) — {verdict}")


if __name__ == "__main__":
    asyncio.run(main())
