#!/usr/bin/env python
"""Throwaway diagnostic: does Google's Agent-Registry MCP mechanism actually work for
the Calendar (Developer Preview) server, independent of the Gemini Enterprise console?

WHY THIS EXISTS. The console's "Data Store -> Actions -> Reload custom actions" flow is
confirmed broken (2026-09-07, real evidence: the underlying dataConnector:refreshDataConnectorTools
call 400s even with a fully correct OAuth 2.0 setup and every relevant IAM role granted —
see docs/AGENT-GATEWAY-REGISTRY-SETUP.md). That console feature is NOT what CS_GE's own
migration code would use, though — the migration code (if it ever adopts this path) would
call ADK's AgentRegistry.get_mcp_toolset() directly, the same mechanism already proven working
live once before against Discovery Engine's own MCP server. This script re-runs that same
proof against the Calendar registry entry specifically, to answer one question: does the
REAL mechanism our code depends on work here, or is Calendar itself somehow different.

NOT part of the shipped migration pipeline. Not imported by adk_deploy.py or anything under
server/src. Run by hand, once, to get an answer — same category as the server/src/spikes/
_diag_*.ts scripts, just Python because the ADK/Agent Engine SDK is Python-only.

WHAT IT DOES. Builds a minimal ADK agent with ONE tool: the Calendar MCP toolset resolved
through Agent Registry. Runs it once via InMemoryRunner with a simple prompt that should
trigger a real tool call (list upcoming calendar events). Prints what tools were discovered
and what the tool call actually returned. Never writes to the calendar — the test prompt
only asks it to list events, and no destructive tool exists in the tool_filter below.

REQUIRES, before running:
  pip install "google-adk[mcp]"          # confirmed correct extra — see adk_deploy.py's
                                          # own comment history for why [agent-identity] and
                                          # [extensions] alone are NOT enough (pull mcp<5,
                                          # while ADK needs mcp>=1.24,<2)
  gcloud auth application-default login  # must be the admin@migrationn.com identity (or
                                          # whichever account has Gemini Enterprise Admin /
                                          # Discovery Engine Admin / MCP Tool User on this
                                          # project — confirmed already granted, screenshot
                                          # 2026-09-07)

RUN (from Cloud Shell, in this project):
  python3 _diag_calendar_mcp_registry.py --project agentmigrations

If AgentRegistry's import path or constructor signature has moved (ADK's internal module
layout changed more than once in the same week this was investigated — see
adk_deploy.py's _build_mcp_toolset comment), this script will say so explicitly rather than
fail with an opaque traceback — the import is wrapped and reported before anything else runs.
"""
import argparse
import sys


REGISTRY_SERVER_NAME = (
    # Exact resource name from the console's "MCP server details" panel — NOT guessed.
    # Display name calendarmcp.googleapis.com, confirmed live 2026-09-07 in the
    # "Create data store" wizard for the CloudFuze Agent Migration Hub app.
    "projects/agentmigrations/locations/global/mcpServers/"
    "agentregistry-00000000-0000-0000-dcfb-6930152208b9"
)

# Narrow on purpose: only read-only, harmless tools. Never include create_event/
# update_event/delete_event/respond_to_event in a throwaway diagnostic — a real calendar
# could get a real (fake) event created by an LLM's own initiative during a test run.
TOOL_FILTER = ["list_events", "list_calendars", "get_event"]

TEST_PROMPT = "What's on my calendar in the next 7 days? Just list what you find."


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--project", required=True, help="GCP project id, e.g. agentmigrations")
    ap.add_argument("--location", default="global", help="Agent Registry location (default: global)")
    args = ap.parse_args()

    print(f"[1/4] Importing ADK MCP toolset support...")
    try:
        from google.adk.tools.mcp_tool.mcp_toolset import McpToolset  # noqa: F401
    except Exception as e:  # noqa: BLE001
        print(f"FAILED to import McpToolset: {e}")
        print("This is the same class adk_deploy.py already uses successfully in the shipped")
        print("pipeline for other tool kinds — if THIS import fails, the environment is missing")
        print("the mcp extra: pip install \"google-adk[mcp]\" (see this script's own docstring).")
        sys.exit(1)

    print(f"[2/4] Importing AgentRegistry (unverified import path — flagging clearly if wrong)...")
    try:
        from google.adk.tools.mcp_tool.agent_registry import AgentRegistry
    except Exception as e:  # noqa: BLE001
        print(f"FAILED to import AgentRegistry from google.adk.tools.mcp_tool.agent_registry: {e}")
        print("This exact import path was written from a single prior successful live call, not")
        print("independently re-verified against the currently installed google-adk version.")
        try:
            import importlib.metadata as _md
            print(f"Installed google-adk version: {_md.version('google-adk')}")
        except Exception:  # noqa: BLE001
            pass
        print("Try: python3 -c \"import google.adk.tools.mcp_tool as m; print(dir(m))\"")
        print("to find where AgentRegistry actually lives in this version, then edit this script.")
        sys.exit(1)

    print(f"[3/4] Resolving the Calendar toolset via Agent Registry...")
    print(f"      registry entry: {REGISTRY_SERVER_NAME}")
    print(f"      tool_filter:    {TOOL_FILTER}  (read-only only, by design)")
    try:
        registry = AgentRegistry(project=args.project)
        toolset = registry.get_mcp_toolset(REGISTRY_SERVER_NAME, tool_filter=TOOL_FILTER)
    except Exception as e:  # noqa: BLE001
        print(f"FAILED to resolve the toolset: {e}")
        print("If this is a 403/permission error: unexpected, since Gemini Enterprise Admin,")
        print("Discovery Engine Admin and MCP Tool User were all already confirmed granted on")
        print("this account (screenshot, 2026-09-07) — worth re-checking WHICH identity this")
        print("script's ADC token actually resolves to (gcloud auth application-default print-access-token")
        print("+ https://oauth2.googleapis.com/tokeninfo?access_token=... to see the real identity).")
        sys.exit(1)

    print(f"[4/4] Building a minimal test agent and running one real prompt...")
    try:
        from google.adk.agents import Agent
        from google.adk.runners import InMemoryRunner
        from google.genai import types as genai_types

        agent = Agent(
            name="calendar_mcp_diag",
            model="gemini-2.5-flash",
            description="Throwaway diagnostic agent — Calendar MCP via Agent Registry.",
            instruction="You have a calendar tool. Use it to answer the user's question.",
            tools=[toolset],
        )
        runner = InMemoryRunner(agent=agent, app_name="calendar_mcp_diag")
        session = runner.session_service.create_session_sync(app_name="calendar_mcp_diag", user_id="diag")

        print(f"      prompt: {TEST_PROMPT!r}\n")
        saw_tool_call = False
        for event in runner.run(
            user_id="diag",
            session_id=session.id,
            new_message=genai_types.Content(role="user", parts=[genai_types.Part(text=TEST_PROMPT)]),
        ):
            for part in getattr(event.content, "parts", []) or []:
                if getattr(part, "function_call", None):
                    saw_tool_call = True
                    print(f"  -> TOOL CALL: {part.function_call.name}({dict(part.function_call.args or {})})")
                if getattr(part, "function_response", None):
                    print(f"  <- TOOL RESULT: {str(part.function_response.response)[:500]}")
                if getattr(part, "text", None):
                    print(f"  MODEL: {part.text}")

        print()
        if saw_tool_call:
            print("RESULT: the agent actually called a Calendar MCP tool through Agent Registry.")
            print("This proves the mechanism works end to end for Calendar, independent of the")
            print("broken console feature. Real, load-bearing evidence — not inferred from logs.")
        else:
            print("RESULT: no tool call observed. The model answered without calling anything, OR")
            print("the toolset was empty. Read the MODEL line above for what it actually said, and")
            print("re-run with a more explicit prompt if the model just answered from memory.")
    except Exception as e:  # noqa: BLE001
        print(f"FAILED during the actual run: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
