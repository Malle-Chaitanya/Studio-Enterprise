/** OpenAI-style tool schemas for Studio Migrate chat agent. */

export const DESTRUCTIVE_TOOLS = new Set(['start_migration']);

export const CONFIRMATION_MESSAGES: Record<string, (args: Record<string, unknown>) => string> = {
  start_migration: (args) =>
    args.dryRun === false
      ? 'Ready to **go live** — this will create/publish real Gemini agents. Are you sure?'
      : 'Ready to run a **dry run** — safe preview, no agents written. Shall I proceed?',
};

export const AGENT_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'navigate_to_step',
      description:
        'Navigate the left workflow panel. Steps: connect, pair, map-users, map, select-data, connectors, migrate, report.',
      parameters: {
        type: 'object',
        properties: {
          step: {
            type: 'string',
            enum: ['connect', 'pair', 'map-users', 'map', 'select-data', 'connectors', 'migrate', 'report'],
          },
        },
        required: ['step'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'set_user_mapping',
      description: 'Map one Microsoft identity email to a Google Workspace email.',
      parameters: {
        type: 'object',
        properties: {
          sourceEmail: { type: 'string' },
          destEmail: { type: 'string' },
        },
        required: ['sourceEmail', 'destEmail'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'auto_map_users',
      description: 'Auto-map Microsoft users to Google by matching email on owned domains.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'clear_mappings',
      description: 'Clear all identity mappings.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_environments',
      description: 'List Copilot Studio / Dataverse environments for the connected tenant.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'set_environment_map',
      description: 'Set which environments are selected for migration (writes client selection).',
      parameters: {
        type: 'object',
        properties: {
          envs: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                env: { type: 'string', description: 'Environment URL' },
                name: { type: 'string' },
              },
              required: ['env', 'name'],
            },
          },
        },
        required: ['envs'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_agents',
      description: 'List agents in a Dataverse environment URL.',
      parameters: {
        type: 'object',
        properties: { env: { type: 'string', description: 'Environment URL' } },
        required: ['env'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'set_agent_selection',
      description: 'Persist which agents are selected for migration.',
      parameters: {
        type: 'object',
        properties: {
          units: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                env: { type: 'string' },
                name: { type: 'string' },
                botIds: { type: 'array', items: { type: 'string' } },
              },
              required: ['env', 'botIds'],
            },
          },
        },
        required: ['units'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'start_migration',
      description: 'Start migration. Requires user confirmation. Call with dryRun true first when unsure.',
      parameters: {
        type: 'object',
        properties: {
          dryRun: { type: 'boolean', description: 'true = dry run (safe), false = live write' },
        },
        required: ['dryRun'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_migration_status',
      description: 'Summarize current wizard client state and whether a plan exists.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'explain_log',
      description: 'Explain a migration log line.',
      parameters: {
        type: 'object',
        properties: { log_line: { type: 'string' } },
        required: ['log_line'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'explain_fidelity',
      description: 'Explain fidelity / lost / needs-review notes for agent migration.',
      parameters: {
        type: 'object',
        properties: { topic: { type: 'string' } },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'show_connectors',
      description: 'Open the Connectors step in the left panel.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];
