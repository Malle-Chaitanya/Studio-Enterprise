"""
CloudFuze Studio Migrate — ADK Agent
Bridges Gemini Agent Platform Studio to migrated Cloud Workflows via the
Cloud Run /api/workflows/execute endpoint.

Deploy to Vertex AI Agent Engine:
  python deploy.py

The deployed agent then appears in:
  console.cloud.google.com/agent-platform/studio → Agent Designer
"""

import os
import httpx
from google.adk.agents import Agent

CLOUD_RUN_BASE = os.environ.get(
    "CLOUD_RUN_BASE_URL",
    "https://studio-enterprise-server-231705905417.us-central1.run.app",
)


def _execute_workflow(workflow: str, args: dict) -> dict:
    """Call Cloud Run /api/workflows/execute and return the JSON result."""
    url = f"{CLOUD_RUN_BASE}/api/workflows/execute"
    payload = {
        "workflow": workflow,
        "project": "studio-enterprise-migration",
        "region": "us-central1",
        "args": args,
    }
    resp = httpx.post(url, json=payload, timeout=30)
    resp.raise_for_status()
    return resp.json()


def create_task(task_title: str, assigned_to: str, priority: str) -> str:
    """Create a migration task in the target system.

    Args:
        task_title: Title of the task to create.
        assigned_to: Email of the person to assign the task to.
        priority: Priority level — high, medium, or low.

    Returns:
        Confirmation message with task details.
    """
    result = _execute_workflow(
        "agent-create-task-demo",
        {"task_title": task_title, "assigned_to": assigned_to, "priority": priority},
    )
    return str(result.get("message", result))


def send_google_chat_message(space_name: str, message_text: str) -> str:
    """Send a message to a Google Chat space.

    Args:
        space_name: Google Chat space name (e.g. spaces/XXXXXX).
        message_text: The message to send.

    Returns:
        Confirmation message.
    """
    result = _execute_workflow(
        "send_google_chat_message",
        {"space_name": space_name, "message_text": message_text},
    )
    return str(result.get("message", result))


def execute_workflow(workflow: str, args: dict = None) -> str:
    """Execute any migrated Cloud Workflow by name.

    Args:
        workflow: Cloud Workflow name (e.g. agent-create-task-demo).
        args: Key-value arguments to pass to the workflow.

    Returns:
        Result message from the workflow.
    """
    result = _execute_workflow(workflow, args or {})
    return str(result.get("message", result))


root_agent = Agent(
    name="studio_migrate_agent",
    model="gemini-2.0-flash",
    description=(
        "CloudFuze Studio Migrate agent. Triggers migrated Cloud Workflows "
        "on behalf of the user — create tasks, send messages, and more."
    ),
    instruction=(
        "You help users trigger their migrated Cloud Workflows. "
        "When a user asks to create a task, collect task_title, assigned_to, and priority, "
        "then call create_task. "
        "When a user asks to send a Google Chat message, collect space_name and message_text, "
        "then call send_google_chat_message. "
        "For any other workflow, use execute_workflow with the workflow name and required args. "
        "After calling a tool, summarise the result clearly. "
        "Do not invent workflow names — only use ones the user specifies."
    ),
    tools=[create_task, send_google_chat_message, execute_workflow],
)
