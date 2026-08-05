#!/usr/bin/env python
"""Deploy one ADK agent as a Vertex AI Reasoning Engine (Agent Runtime).

Called by services/adkDeployer.ts. Reads an ADK spec (JSON), builds an ADK
LlmAgent, deploys it, and prints ONE JSON line on stdout:
    {"reasoningEngine": "projects/.../locations/.../reasoningEngines/..."}   on success
    {"error": "..."}                                                          on failure

Auth: uses GOOGLE_SA_KEY_FILE (or GOOGLE_APPLICATION_CREDENTIALS) — same SA the
migration tool uses. Requires a GCS staging bucket (--staging-bucket or
ADK_STAGING_BUCKET); it is auto-created if missing.

    python adk_deploy.py --project P --location us-central1 \
        --spec '{"name":"...","displayName":"...","instruction":"...","model":"gemini-2.5-flash","tools":["googleSearch"]}' \
        --staging-bucket gs://my-bucket

If spec.groundingDataStores is set (one or more Discovery Engine data store
resource paths — a public-website store from adkDeployer.ts
createWebsiteGroundingDataStore, and/or "document" stores for locally-uploaded
files from knowledgeDataStoreExecutor.migrateFileToDocumentStore),
VertexAiSearchTool is wired as the agent's ONLY tool: a single store uses
`data_store_id`, multiple stores combine via `data_store_specs`. ADK (pre-1.16)
only allows VertexAiSearchTool alone on an agent — it cannot be combined with
google_search or any other tool — so `tools` is ignored whenever
groundingDataStores is non-empty.
"""
import argparse
import json
import os
import sys


def emit(obj):
    # The Node caller parses the LAST stdout line as JSON.
    print(json.dumps(obj), flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", required=True)
    ap.add_argument("--location", default="us-central1")
    ap.add_argument("--spec", help="ADK spec as JSON (inline)")
    ap.add_argument("--spec-file", help="path to a file containing the ADK spec JSON")
    ap.add_argument("--staging-bucket", default=os.environ.get("ADK_STAGING_BUCKET"))
    args = ap.parse_args()

    try:
        raw = open(args.spec_file, encoding="utf-8").read() if args.spec_file else args.spec
        if not raw:
            emit({"error": "provide --spec or --spec-file"}); return
        spec = json.loads(raw)
    except Exception as e:  # noqa: BLE001
        emit({"error": f"bad spec json: {e}"}); return

    # Auth: point ADC at the SA key the tool already uses.
    key = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS") or os.environ.get("GOOGLE_SA_KEY_FILE")
    if key and not os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"):
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = key

    try:
        import vertexai
        from vertexai import agent_engines
        from google.adk.agents import Agent
    except Exception as e:  # noqa: BLE001
        emit({"error": f"SDK import failed (pip install 'google-cloud-aiplatform[agent_engines]' google-adk): {e}"}); return

    # Ensure a staging bucket exists (Agent Engine needs one to package code).
    bucket = args.staging_bucket
    if not bucket:
        bucket = f"gs://{args.project}-adk-staging"
    try:
        from google.cloud import storage
        client = storage.Client(project=args.project)
        name = bucket.replace("gs://", "").split("/")[0]
        if not client.lookup_bucket(name):
            client.create_bucket(name, location=args.location)
    except Exception as e:  # noqa: BLE001
        emit({"error": f"staging bucket setup failed ({bucket}): {e}"}); return

    # Build tools from the spec. VertexAiSearchTool requires EXACTLY ONE of
    # data_store_id / search_engine_id per instance (confirmed against the
    # installed google-adk 2.5.0 source, vertex_ai_search_tool.py's own
    # constructor: it raises "Either data_store_id or search_engine_id must be
    # specified" unless exactly one is set — data_store_specs is NOT a way to
    # combine independent stores, it's a scoping filter that's only valid
    # ALONGSIDE search_engine_id, which we don't have/want here since that
    # would mean searching a whole Discovery Engine "engine" resource instead
    # of the specific per-agent stores this pipeline resolved). So multiple
    # data stores become multiple VertexAiSearchTool instances instead, one
    # per store, each with bypass_multi_tools_limit=True — that flag (present
    # on this ADK version, not documented anywhere in this codebase before
    # this fix) makes ADK auto-wrap each as a DiscoveryEngineSearchTool when
    # there's more than one tool on the agent, instead of rejecting the
    # combination outright (see llm_agent.py's _convert_tool_union_to_tools).
    # Harmless to set even when there's only one store: ADK only applies the
    # wrapping when multiple tools are actually present.
    tools = []
    grounding_data_stores = spec.get("groundingDataStores") or []
    try:
        if grounding_data_stores:
            from google.adk.tools import VertexAiSearchTool
            for ds in grounding_data_stores:
                tools.append(VertexAiSearchTool(data_store_id=ds, bypass_multi_tools_limit=True))
        elif "googleSearch" in (spec.get("tools") or []):
            from google.adk.tools import google_search
            tools.append(google_search)
    except Exception as e:  # noqa: BLE001
        emit({"error": f"tool wiring failed: {e}"}); return

    try:
        root_agent = Agent(
            name=spec.get("name", "migrated_agent"),
            model=spec.get("model", "gemini-2.5-flash"),
            description=spec.get("description", ""),
            instruction=spec.get("instruction", "") or "You are a helpful assistant.",
            tools=tools,
        )
    except Exception as e:  # noqa: BLE001
        emit({"error": f"agent build failed: {e}"}); return

    try:
        vertexai.init(project=args.project, location=args.location, staging_bucket=bucket)
        remote = agent_engines.create(
            agent_engine=root_agent,
            display_name=spec.get("displayName", spec.get("name", "Migrated Agent")),
            requirements=["google-cloud-aiplatform[agent_engines,adk]", "google-adk"],
        )
        emit({"reasoningEngine": remote.resource_name})
    except Exception as e:  # noqa: BLE001
        emit({"error": f"deploy failed: {e}"})


if __name__ == "__main__":
    main()
