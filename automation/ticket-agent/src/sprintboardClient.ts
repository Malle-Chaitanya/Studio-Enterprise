import type { Config } from './config.js';
import type { Issue } from './types.js';

export class SprintBoardClient {
  constructor(private readonly config: Config) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.config.sprintboardBaseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.config.sprintboardToken}`,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`SprintBoard ${init?.method ?? 'GET'} ${path} failed: ${res.status} ${body}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  // Confirmed shape: { assigned: Issue[], ... } - NOT a flat array. Only
  // "assigned" is used here; other top-level keys (if any) are ignored since
  // this tool only cares about tickets assigned to the operator.
  async getMyIssues(): Promise<Issue[]> {
    const response = await this.request<{ assigned: Issue[] }>('/api/my-issues');
    return response.assigned;
  }

  // GET /api/issues/:key accepts the human key (e.g. "AI-317") directly, not
  // just the internal uuid - confirmed by direct probe, not documented anywhere.
  getIssueByKey(key: string): Promise<Issue> {
    return this.request<Issue>(`/api/issues/${key}`);
  }

  listIssuesInSpace(spaceId: string): Promise<Issue[]> {
    return this.request<Issue[]>(`/api/issues?space_id=${spaceId}`);
  }

  // No first-party API docs exist for this - shape confirmed by probing
  // validation errors on an empty POST body (400s, never a partial write) and
  // by reading back a ticket another session had already created via this
  // endpoint. assignee_id/reporter_id default to the token's own user when
  // omitted; pass them explicitly to assign elsewhere.
  createIssue(payload: {
    space_id: string;
    title: string;
    description?: string;
    type?: Issue['type'];
    priority?: string;
    assignee_id?: string;
    reporter_id?: string;
  }): Promise<Issue> {
    return this.request<Issue>('/api/issues', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  updateIssue(id: string, patch: Partial<Issue>): Promise<Issue> {
    return this.request<Issue>(`/api/issues/${id}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    });
  }

  postComment(issueId: string, body: string): Promise<void> {
    return this.request(`/api/comments`, {
      method: 'POST',
      body: JSON.stringify({
        issue_id: issueId,
        user_id: this.config.userId,
        body,
        mentioned_user_ids: [],
      }),
    });
  }
}
