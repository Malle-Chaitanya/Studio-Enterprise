"""
Deploy the ADK agent to Vertex AI Agent Engine.

Usage:
  pip install google-adk httpx google-cloud-aiplatform
  python deploy.py

The agent appears in Agent Platform Studio after ~2 min:
  console.cloud.google.com/agent-platform/studio?project=studio-enterprise-migration
"""

import vertexai
from vertexai import agent_engines
from agent import root_agent

PROJECT = "studio-enterprise-migration"
LOCATION = "us-central1"
STAGING_BUCKET = f"gs://{PROJECT}-adk-staging"

vertexai.init(project=PROJECT, location=LOCATION)

print(f"Deploying {root_agent.name} to Vertex AI Agent Engine...")
print(f"  Project:  {PROJECT}")
print(f"  Location: {LOCATION}")
print(f"  Bucket:   {STAGING_BUCKET}")

remote_agent = agent_engines.create(
    root_agent,
    requirements=["google-adk>=1.0.0", "httpx>=0.27.0"],
    display_name="Studio Migrate Agent",
    description=(
        "CloudFuze Studio Migrate — triggers migrated Cloud Workflows via Gemini Agent Studio."
    ),
    staging_bucket=STAGING_BUCKET,
)

print(f"\n✅ Deployed successfully!")
print(f"   Resource name: {remote_agent.resource_name}")
print(f"\nAgent visible in:")
print(f"   https://console.cloud.google.com/agent-platform/studio?project={PROJECT}")
print(f"\nTo query the deployed agent:")
print(f"   session = remote_agent.create_session(user_id='test')")
print(f"   for event in remote_agent.stream_query(")
print(f"       user_id='test', session_id=session['id'],")
print(f"       message='Create a task for Contoso migration, assign to mia@cloudfuze.com, high priority'")
print(f"   ):")
print(f"       print(event)")
