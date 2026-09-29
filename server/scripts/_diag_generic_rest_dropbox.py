#!/usr/bin/env python
"""Throwaway diagnostic: does CS_GE's OWN bound-operation tool builder
(connector_tools/generic_rest.py, the REAL production module, imported
unmodified) actually produce a working Dropbox tool -- as opposed to
Google's Integration Connectors, which was tested separately and ruled out
for business reasons (see chat transcript, 2026-09-21).

WHY THIS EXISTS. generic_rest.py has TWO code paths:
  1. `bound_ops` present  -> one specific, typed, well-described tool per
     operation (_make_bound_tool). NEVER recorded as failing.
  2. `bound_ops` empty    -> the weak `call_external_api` fallback, which
     IS recorded as failing for Drive and Confluence (see hubspot.py's own
     module docstring, dated 2026-08-20).

Dropbox is a 'vendor-path' connector (proven live earlier this session), so
in real production it would take path (1), not (2). This script builds a
`conn` dict shaped the way the real server would for one real Dropbox
operation, and calls the REAL build_tools() -- not a reimplementation.

RUN:
  DROPBOX_TOKEN="<paste>" python _diag_generic_rest_dropbox.py
"""
import asyncio
import os
import sys

DROPBOX_TOKEN = os.environ.get("DROPBOX_TOKEN", "").strip()
if not DROPBOX_TOKEN:
    print("Set DROPBOX_TOKEN in the environment first.")
    sys.exit(1)


def main() -> None:
    print("[1/3] Importing the REAL, unmodified generic_rest.py from this repo...")
    try:
        from connector_tools.generic_rest import build_tools
    except Exception as e:  # noqa: BLE001
        print(f"FAILED to import: {e}")
        sys.exit(1)

    print("[1/3] Shaping a `conn` dict the way the real server would for Dropbox...")
    conn = {
        "kind": "dropbox",
        "name": "Dropbox",
        "authKind": "bearer",
        "boundOperations": [
            {
                "operationId": "ListFolder",
                "toolName": "list_root_folder",
                "method": "POST",
                "urlTemplate": "https://api.dropboxapi.com/2/files/list_folder",
                # Dropbox's real v2 API wants one JSON body, not query params -- this is
                # exactly the "in": "body" path _make_bound_tool already supports.
                "fixedArgs": {"body": {"in": "body", "value": {"path": ""}}},
                "modelArgs": [],
                "contextRequired": [],
                "contextValues": {},
                "auth": "bearer",
                "description": "Lists the files and folders at the root of the user's Dropbox.",
            }
        ],
    }

    def secret(name: str) -> str:
        return {"api_key": DROPBOX_TOKEN}.get(name, "")

    def auth_header(fill) -> str:
        return f"Bearer {DROPBOX_TOKEN}"

    def fill(tpl: str) -> str:
        return tpl

    def mint_token(*_a, **_k) -> str:
        return ""

    print("[2/3] Calling the REAL build_tools()...")
    tools = build_tools(conn, secret, mint_token, auth_header, fill)
    print(f"RESULT: {len(tools)} real tool(s) built:")
    for t in tools:
        print(f"  - {t.__name__}: {(t.__doc__ or '').splitlines()[0]}")

    print("\n[3/3] Wiring the REAL tool into a minimal ADK agent and asking it a question...")
    from google.adk.agents import Agent
    from google.adk.runners import InMemoryRunner
    from google.genai import types as genai_types

    agent = Agent(
        name="dropbox_generic_rest_diag",
        model="gemini-3.6-flash",
        description="Throwaway diagnostic agent -- CS_GE's own generic_rest.py tool for Dropbox.",
        instruction="You have a Dropbox tool available. Use it to answer the user's question.",
        tools=tools,
    )
    runner = InMemoryRunner(agent=agent, app_name="dropbox_generic_rest_diag")
    session = runner.session_service.create_session_sync(
        app_name="dropbox_generic_rest_diag", user_id="diag"
    )

    prompt = "What files and folders are at the root of my Dropbox?"
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
                print(f"  <- TOOL RESULT: {part.function_response.response}")
            if getattr(part, "text", None):
                print(f"  MODEL: {part.text}")

    print()
    if saw_tool_call:
        print("RESULT: CS_GE's OWN production code (generic_rest.py, bound-operation path)")
        print("actually called Dropbox for real, unmodified, no Google product involved.")
    else:
        print("RESULT: no tool call observed -- the model declined or ignored the tool.")
        print("This would be the SAME failure mode already recorded for Drive/Confluence's")
        print("weak fallback -- except this is supposed to be the STRONG, typed path.")


if __name__ == "__main__":
    main()
