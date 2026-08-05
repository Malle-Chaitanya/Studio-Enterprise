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
createWebsiteGroundingDataStore, and/or "document"/connector stores for
locally-uploaded files or SharePoint/Dataverse sources), grounding is wired as
the agent's ONLY tool(s), taking priority over `tools`. A single store uses
the built-in VertexAiSearchTool directly. Multiple stores use hand-rolled
FunctionTools instead (see _make_search_tool) — NOT N VertexAiSearchTool
instances combined via bypass_multi_tools_limit, which deploys fine but
crashes every query with "Duplicate function declaration found:
discovery_engine_search" (confirmed live 2026-08-05 — ADK's auto-wrap gives
every instance the same hardcoded function name; see the comment on
_make_search_tool for the full writeup and upstream issue links).
"""
import argparse
import json
import os
import sys


def emit(obj):
    # The Node caller parses the LAST stdout line as JSON.
    print(json.dumps(obj), flush=True)


# Multiple data stores do NOT use N VertexAiSearchTool instances with
# bypass_multi_tools_limit=True — that was tried and confirmed broken live
# (2026-08-05): ADK auto-wraps each into a DiscoveryEngineSearchTool at QUERY
# time, but that wrapper's declared function name is hardcoded to
# "discovery_engine_search" (discovery_engine_search_tool.py's __init__
# always does `super().__init__(self.discovery_engine_search)`, with no way
# to override the name — confirmed unchanged on google/adk-python@main, not a
# version lag; see open upstream issues #3146 and #3406 acknowledging this
# wrapper path is unfinished). 2+ instances always collide with "Duplicate
# function declaration found: discovery_engine_search", breaking every query
# on the agent.
#
# search_engine_id + data_store_specs (Vertex AI Search's own way to scope ONE
# tool across several stores) was also considered and rejected: per
# google.genai.types' own docstring, data_store_specs is "only considered for
# Engines with multiple data stores" — it requires the stores to already be
# attached to a shared Engine resource, which would mean every migrated
# agent's knowledge becomes visible to every other agent on that Engine, the
# exact per-agent-isolation loss this pipeline is built to avoid (see
# docs/knowledge-sources-migration-playbook.md and the 2026-08-04
# knowledge-parity fix).
#
# So: hand-roll one FunctionTool per data store instead, each wrapping a
# closure that calls discoveryengine_v1beta.SearchServiceClient.search
# directly against ONLY that store's serving config — the same call
# DiscoveryEngineSearchTool._do_search makes internally (mirrored here,
# CHUNKS mode only — this pipeline's stores are all unstructured
# document/file/connector stores, not structured tables, so the
# DOCUMENTS-mode fallback that class also has isn't needed). Each closure's
# __name__ is set explicitly before wrapping, so the FunctionDeclaration ADK
# sends to Gemini is genuinely distinct per store — the collision is
# structurally impossible this way, not just avoided.
def _make_search_tool(data_store_id, tool_name):
    from google.adk.tools import FunctionTool

    # `serving_config` is a plain string — the ONLY thing this closure
    # captures. The SearchServiceClient must NOT be constructed here and
    # captured by the closure: Agent Engine deployment serializes (pickles)
    # the whole agent, including its tools, to ship it to the cloud, and a
    # live gRPC client (open credentials/channel state) isn't picklable.
    # Confirmed live 2026-08-05: capturing a pre-built client made deploy
    # itself fail with "Failed to serialize agent engine." The client is
    # instead built fresh INSIDE _search on every call — cheap (a local
    # client object, no network round-trip until .search() itself) and
    # avoids serialization entirely, since only serving_config (a string)
    # needs to survive the pickle.
    serving_config = f"{data_store_id}/servingConfigs/default_config"

    def _run_search(discoveryengine, client, query, mode):
        spec_cls = discoveryengine.SearchRequest.ContentSearchSpec
        if mode == "DOCUMENTS":
            content_search_spec = spec_cls(search_result_mode=spec_cls.SearchResultMode.DOCUMENTS)
        else:
            content_search_spec = spec_cls(
                search_result_mode=spec_cls.SearchResultMode.CHUNKS,
                chunk_spec=spec_cls.ChunkSpec(num_previous_chunks=0, num_next_chunks=0),
            )
        request = discoveryengine.SearchRequest(
            serving_config=serving_config,
            query=query,
            content_search_spec=content_search_spec,
        )
        response = client.search(request)
        results = []
        for item in response.results:
            if mode == "DOCUMENTS":
                doc = item.document
                if not doc:
                    continue
                title, uri, content = "", "", ""
                if doc.struct_data:
                    data = dict(doc.struct_data)
                    title = data.pop("title", "")
                    uri = data.pop("uri", data.pop("link", ""))
                    content = json.dumps(data)
                elif doc.derived_struct_data:
                    data = dict(doc.derived_struct_data)
                    title = data.get("title", "")
                    uri = data.get("link", "")
                    snippets = data.get("snippets", [])
                    content = "\n".join(str(s.get("snippet", s)) for s in snippets) if snippets else ""
                results.append({"title": title, "url": uri, "content": content})
            else:
                chunk = item.chunk
                if not chunk:
                    continue
                title, uri = "", ""
                doc_metadata = chunk.document_metadata
                if doc_metadata:
                    title = doc_metadata.title
                    uri = doc_metadata.uri
                results.append({"title": title, "url": uri, "content": chunk.content})
        return results

    def _search(query: str) -> dict:
        """Search this agent's attached knowledge source for information relevant to the query.

        Args:
          query: The search query.

        Returns:
          A dict with the search status and any matching results (title, url, content).
        """
        from google.api_core.exceptions import GoogleAPICallError
        from google.cloud import discoveryengine_v1beta as discoveryengine
        import google.auth

        credentials, _ = google.auth.default()
        client = discoveryengine.SearchServiceClient(credentials=credentials)
        try:
            # Auto-detect, same as ADK's own DiscoveryEngineSearchTool: most
            # data stores (uploaded files, SharePoint connector) are
            # unstructured and need CHUNKS mode; structured stores (e.g.
            # Dataverse-snapshot tables) reject CHUNKS and require DOCUMENTS —
            # confirmed live 2026-08-05 against a real SharePoint-connector
            # store: "content_search_spec.search_result_mode must be set to
            # ...DOCUMENTS when the engine contains structured data store."
            try:
                results = _run_search(discoveryengine, client, query, "CHUNKS")
            except GoogleAPICallError as e:
                if "DOCUMENTS" in str(e) and "search_result_mode" in str(e):
                    results = _run_search(discoveryengine, client, query, "DOCUMENTS")
                else:
                    raise
            return {"status": "success", "results": results}
        except GoogleAPICallError as e:
            return {"status": "error", "error_message": str(e)}

    _search.__name__ = tool_name
    return FunctionTool(_search)


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

    # Build tools from the spec. A single data store uses the built-in
    # VertexAiSearchTool directly — proven working, no issues. Multiple data
    # stores use _make_search_tool (module-level, see its comment above for
    # the full reasoning) instead of combining VertexAiSearchTool instances.
    tools = []
    grounding_data_stores = spec.get("groundingDataStores") or []
    try:
        if len(grounding_data_stores) == 1:
            from google.adk.tools import VertexAiSearchTool
            tools.append(VertexAiSearchTool(data_store_id=grounding_data_stores[0]))
        elif len(grounding_data_stores) > 1:
            for i, ds in enumerate(grounding_data_stores):
                tools.append(_make_search_tool(ds, f"search_knowledge_source_{i + 1}"))
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

    # bypass_multi_tools_limit=True (set above whenever grounding data stores are
    # present) makes ADK wrap VertexAiSearchTool as a DiscoveryEngineSearchTool
    # at QUERY time (not deploy/construction time — confirmed live: deploy
    # succeeds either way, but every query then fails at import), and that
    # class does `from google.cloud import discoveryengine_v1beta` — a module
    # `google-cloud-aiplatform[agent_engines,adk]`/`google-adk` do NOT pull in.
    # Without this, the DEPLOYED reasoning engine has no way to install it —
    # confirmed live 2026-08-05: a real 2-knowledge-source agent deployed fine,
    # then every single query (including one needing no tool at all) failed
    # with "ImportError: cannot import name 'discoveryengine_v1beta'".
    requirements = ["google-cloud-aiplatform[agent_engines,adk]", "google-adk"]
    if grounding_data_stores:
        requirements.append("google-cloud-discoveryengine")

    try:
        vertexai.init(project=args.project, location=args.location, staging_bucket=bucket)
        remote = agent_engines.create(
            agent_engine=root_agent,
            display_name=spec.get("displayName", spec.get("name", "Migrated Agent")),
            requirements=requirements,
        )
        emit({"reasoningEngine": remote.resource_name})
    except Exception as e:  # noqa: BLE001
        emit({"error": f"deploy failed: {e}"})


if __name__ == "__main__":
    main()
