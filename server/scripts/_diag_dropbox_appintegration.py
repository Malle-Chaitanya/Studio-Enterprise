#!/usr/bin/env python
"""Throwaway diagnostic: does Tier 0 (ApplicationIntegrationToolset over a real Integration
Connectors Connection) actually expose a working Dropbox tool, and does it make a real call?

WHY THIS EXISTS. CS_GE has no Dropbox binder today — confirmed: no VENDOR_BINDINGS entry, no
connector_tools/dropbox.py, no captured fixture (grep run 2026-09-18). The candidate
replacement is Google's managed Integration Connectors + ADK's ApplicationIntegrationToolset.
That class was already proven IMPORTABLE and REACHABLE against a placeholder project in this
same investigation: construction failed with a real permissions error from Google's live API
("Please provide a service account that has the required permissions to access the
connection"), not an import error. This script is the next step — run it against a REAL
Connection in a real project and see what it actually returns, before touching adk_deploy.py.

NOT part of the shipped migration pipeline. Not imported by adk_deploy.py or anything under
server/src. Run by hand, once, to get an answer — same category as
_diag_calendar_mcp_registry.py, which this deliberately mirrors.

REQUIRES, before running:
  1. A Dropbox OAuth app registered at https://www.dropbox.com/developers/apps
     (gives you a Client ID + Client Secret).
  2. A Connection already created in Integration Connectors (console) using those credentials,
     and AUTHORIZED — status must show ACTIVE, not "Authorization required". The OAuth consent
     step happens AFTER the Connection is saved; it will not work until that's done.
  3. gcloud auth application-default login, as an identity holding roles/connectors.viewer +
     roles/connectors.user (or broader, e.g. Editor, for this throwaway test) on the project
     that holds the Connection.
  4. google-adk already pinned in server/requirements.txt (2.6.2) — reuse that venv, or
     pip install google-adk.

RUN — step 1 only (enumerate tools, no LLM call, no cost, safest first move):
  python3 _diag_dropbox_appintegration.py --project studio-enterprise-migration \
      --location us-central1 --connection dropbox-test --skip-run \
      --entity Files --entity-ops LIST,GET

Read what comes back. THAT tells you the real, current answer to "does Dropbox expose a
listing operation" — settling the open question from the docs-only comparison earlier — before
you spend anything on an actual model call.

RUN — step 2 (only once step 1 shows tools you trust), to prove a REAL call happens:
  python3 _diag_dropbox_appintegration.py --project studio-enterprise-migration \
      --location us-central1 --connection dropbox-test \
      --entity Files --entity-ops LIST,GET \
      --prompt "List whatever files you can see."

CAUTION, same as _diag_calendar_mcp_registry.py's own TOOL_FILTER discipline: do not pass
destructive actions (DeleteResource, MoveResource, RenameResource, UnshareFolder) into
--actions for an exploratory run. Read-only entity ops (LIST, GET) or DownloadFile only, until
you trust what is actually happening.
"""
import argparse
import asyncio
import sys


def enumerate_tools(project: str, location: str, connection: str, actions: list[str], entities: dict):
    print("[1/2] Importing ApplicationIntegrationToolset...")
    try:
        from google.adk.tools.application_integration_tool.application_integration_toolset import (
            ApplicationIntegrationToolset,
        )
    except Exception as e:  # noqa: BLE001
        print(f"FAILED to import: {e}")
        print("This is the same class already proven importable in this investigation against")
        print("google-adk 2.5.0 locally / 2.6.2 pinned in server/requirements.txt. If THIS fails,")
        print("the environment running this script is not the one that was already verified.")
        sys.exit(1)

    print(f"[1/2] Building toolset for connection={connection!r} in {project}/{location} ...")
    print(f"      actions={actions or None}  entity_operations={entities or None}")
    try:
        toolset = ApplicationIntegrationToolset(
            project=project,
            location=location,
            connection=connection,
            actions=actions or None,
            entity_operations=entities or None,
        )
    except Exception as e:  # noqa: BLE001
        print(f"FAILED to construct toolset: {e}")
        print("- 'service account permissions' -> the ADC identity lacks Integration Connectors")
        print("  access on THIS connection (roles/connectors.viewer + roles/connectors.user).")
        print("- 'connection not found' / unauthorized -> the Connection may not be ACTIVE yet;")
        print("  finish the OAuth 'Authorize' step in the console first.")
        print("- ValueError about integration/connection args -> pass EITHER --entity+--entity-ops")
        print("  OR --actions, at least one of them, per the class's own docstring.")
        sys.exit(1)

    print("[1/2] Fetching tools (this calls Google's live Connections/Integration API)...")
    try:
        tools = asyncio.run(toolset.get_tools())
    except Exception as e:  # noqa: BLE001
        print(f"FAILED while fetching tools: {e}")
        sys.exit(1)

    if not tools:
        print("RESULT: zero tools returned. The connection exists but exposes nothing for the")
        print("actions/entity_operations given. Try different names (check the Connection's own")
        print("schema/actions tab in the console for the exact valid strings), or widen the ask.")
        return []

    print(f"RESULT: {len(tools)} tool(s) returned — this is the real, current answer, not a")
    print("documentation summary:\n")
    for t in tools:
        print(f"  - {t.name}: {t.description}")
    return tools


def run_agent(tools, prompt: str):
    print("\n[2/2] Building a minimal test agent with these real tools and asking it a question...")
    from google.adk.agents import Agent
    from google.adk.runners import InMemoryRunner
    from google.genai import types as genai_types

    agent = Agent(
        name="dropbox_appint_diag",
        model="gemini-2.5-flash",
        description="Throwaway diagnostic agent -- Dropbox via Integration Connectors.",
        instruction="You have Dropbox tools available. Use whichever tool actually answers the question.",
        tools=tools,
    )
    runner = InMemoryRunner(agent=agent, app_name="dropbox_appint_diag")
    session = runner.session_service.create_session_sync(app_name="dropbox_appint_diag", user_id="diag")

    print(f"      prompt: {prompt!r}\n")
    saw_tool_call = False
    for event in runner.run(
        user_id="diag",
        session_id=session.id,
        new_message=genai_types.Content(role="user", parts=[genai_types.Part(text=prompt)]),
    ):
        for part in getattr(event.content, "parts", []) or []:
            if getattr(part, "function_call", None):
                saw_tool_call = True
                print(f"  -> TOOL CALL: {part.function_call.name}({dict(part.function_call.args or {})})")
            if getattr(part, "function_response", None):
                print(f"  <- TOOL RESULT (full, untruncated): {part.function_response.response}")
            if getattr(part, "text", None):
                print(f"  MODEL: {part.text}")

    print()
    if saw_tool_call:
        print("RESULT: a real tool call happened end to end. This is load-bearing evidence Tier 0")
        print("actually works for Dropbox -- not inferred from docs, not inferred from imports.")
    else:
        print("RESULT: no tool call observed. Read the MODEL line above -- the model may have")
        print("declined, or the tool set didn't match the prompt. Try naming one tool explicitly.")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--project", required=True, help="GCP project id, e.g. studio-enterprise-migration")
    ap.add_argument("--location", default="us-central1", help="Region the Connection runs in")
    ap.add_argument("--connection", required=True, help="Connection name, e.g. dropbox-test")
    ap.add_argument("--actions", default="", help="comma-separated action names, e.g. DownloadFile")
    ap.add_argument("--entity", default="", help="entity name, e.g. Files")
    ap.add_argument("--entity-ops", default="", help="comma-separated ops for --entity, e.g. LIST,GET")
    ap.add_argument("--skip-run", action="store_true", help="only enumerate tools, don't run the agent")
    ap.add_argument(
        "--prompt",
        default="List whatever files or folders you can access, using any tool you have.",
    )
    args = ap.parse_args()

    actions = [a.strip() for a in args.actions.split(",") if a.strip()]
    entities: dict[str, list[str]] = {}
    if args.entity:
        entities[args.entity] = [o.strip() for o in args.entity_ops.split(",") if o.strip()]

    if not actions and not entities:
        print("Pass at least one of --actions or (--entity + --entity-ops). See --help.")
        sys.exit(1)

    tools = enumerate_tools(args.project, args.location, args.connection, actions, entities)
    if tools and not args.skip_run:
        run_agent(tools, args.prompt)


if __name__ == "__main__":
    main()
