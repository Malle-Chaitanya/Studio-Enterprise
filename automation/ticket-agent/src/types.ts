export interface Issue {
  id: string;
  key: string;
  space_id: string;
  title: string;
  description: string | null;
  fix_description: string | null;
  type: 'epic' | 'story' | 'task' | 'bug' | 'subtask';
  status: string;
  priority: string;
  assignee_id: string | null;
  reporter_id: string | null;
}
