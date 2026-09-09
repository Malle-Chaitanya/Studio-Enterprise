"""Sanity check, half 1 of 2: serve a toy ADK agent over A2A on localhost.

Tests whether ADK's `to_a2a()` + `RemoteA2aAgent` actually delegate a turn
across two independent agent PROCESSES (the closest local stand-in for two
independently-deployed Reasoning Engines, which is what a real Copilot Studio
"connected agent" maps to per this session's research) — not whether the docs
merely claim it works.

Runs entirely locally, no GCP deployment, no billable resources. Requires
`google-adk` installed and Gemini API credentials available to the process
(GOOGLE_API_KEY, or Vertex ADC via GOOGLE_APPLICATION_CREDENTIALS +
GOOGLE_GENAI_USE_VERTEXAI=1 — either works, ADK picks it up the same way
adk_deploy.py's local runs do).

Plants an unmistakable marker ("A2A_MARKER_9K2L") in this agent's instruction
so the caller side (_diag_a2a_sanity_agent_a_test.py) can prove the reply
really came from THIS process over the network, not from agent A improvising.

Run this FIRST, leave it running, then run the agent_a test script in a
second terminal:
    python _diag_a2a_sanity_agent_b_server.py
"""
import os

from google.adk.agents import Agent
from google.adk.a2a.utils.agent_to_a2a import to_a2a

MARKER = "A2A_MARKER_9K2L"

root_agent = Agent(
    name="billing_agent_b",
    model="gemini-2.5-flash",
    description="Handles ALL billing, invoice, payment, and refund questions.",
    instruction=(
        f"You are a standalone billing agent, running as your own separate process. "
        f'For ANY question you answer, start your reply with the exact literal text '
        f'"{MARKER}" (no quotes) before anything else — this is a fixed internal '
        f"marker for a delegation test, not something to explain to the user."
    ),
)

# Auto-generates an in-memory agent card (name/description/skills) from this
# agent, per adk.dev/a2a/quickstart-exposing/ — the same mechanism a real
# migrated "connected agent" would need to expose itself to a parent.
a2a_app = to_a2a(root_agent, port=8001)

if __name__ == "__main__":
    import uvicorn

    print(f"Serving billing_agent_b over A2A on http://localhost:8001")
    print(f"Agent card should appear at http://localhost:8001/.well-known/agent.json")
    uvicorn.run(a2a_app, host="localhost", port=8001)
