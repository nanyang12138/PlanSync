/**
 * OpenAPI 3.0.3 specification for the PlanSync HTTP API (served at /api/*).
 */
export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'PlanSync API',
    version: '1.0.0',
    description:
      'AI Team Plan Coordination Platform API. Authenticate with `Authorization: Bearer <token>`. ' +
      'Use either `PLANSYNC_SECRET` (with `X-User-Name`) or a project API key (`ps_key_...`).',
  },
  servers: [{ url: '/api', description: 'Current server (relative to app origin)' }],
  security: [{ bearerSecret: [] }, { bearerApiKey: [] }],
  tags: [
    { name: 'Projects', description: 'Project management and project-scoped aggregates' },
    { name: 'Plans', description: 'Plan lifecycle (draft, propose, activate)' },
    { name: 'Reviews', description: 'Plan review workflow' },
    { name: 'Tasks', description: 'Task management, execution runs, and task pack' },
    { name: 'Drift', description: 'Drift detection and resolution' },
    { name: 'Members', description: 'Project member management' },
    { name: 'Suggestions', description: 'Plan suggestions' },
    { name: 'Comments', description: 'Plan discussions' },
    { name: 'Activities', description: 'Activity log' },
    { name: 'Webhooks', description: 'Webhook registration and delivery' },
    { name: 'Auth', description: 'Authentication and API keys' },
    { name: 'Health', description: 'System health' },
  ],
  components: {
    securitySchemes: {
      bearerSecret: {
        type: 'http',
        scheme: 'bearer',
        description:
          'Shared secret from `PLANSYNC_SECRET`. Requires `X-User-Name` header (or `?user=` when auth disabled).',
      },
      bearerApiKey: {
        type: 'http',
        scheme: 'bearer',
        description:
          'Project API key (`ps_key_...`). Acts as the key creator; no `X-User-Name` required.',
      },
    },
    parameters: {
      Page: {
        name: 'page',
        in: 'query',
        schema: { type: 'integer', minimum: 1, default: 1 },
        description: 'Page number (1-based)',
      },
      PageSize: {
        name: 'pageSize',
        in: 'query',
        schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        description: 'Items per page',
      },
      ProjectId: {
        name: 'projectId',
        in: 'path',
        required: true,
        schema: { type: 'string' },
      },
      PlanId: {
        name: 'planId',
        in: 'path',
        required: true,
        schema: { type: 'string' },
      },
      TaskId: {
        name: 'taskId',
        in: 'path',
        required: true,
        schema: { type: 'string' },
      },
      DriftId: {
        name: 'driftId',
        in: 'path',
        required: true,
        schema: { type: 'string' },
      },
      MemberId: {
        name: 'memberId',
        in: 'path',
        required: true,
        schema: { type: 'string' },
      },
      WebhookId: {
        name: 'webhookId',
        in: 'path',
        required: true,
        schema: { type: 'string' },
      },
      KeyId: {
        name: 'keyId',
        in: 'path',
        required: true,
        schema: { type: 'string' },
      },
      SuggestionId: {
        name: 'suggestionId',
        in: 'path',
        required: true,
        schema: { type: 'string' },
      },
      CommentId: {
        name: 'commentId',
        in: 'path',
        required: true,
        schema: { type: 'string' },
      },
      ReviewId: {
        name: 'reviewId',
        in: 'path',
        required: true,
        schema: { type: 'string' },
      },
      RunId: {
        name: 'runId',
        in: 'path',
        required: true,
        schema: { type: 'string' },
      },
      DriftStatus: {
        name: 'status',
        in: 'query',
        schema: { type: 'string', enum: ['open', 'resolved'] },
        description: 'Filter drift alerts by status',
      },
      TaskStatus: {
        name: 'status',
        in: 'query',
        schema: { type: 'string', enum: ['todo', 'in_progress', 'blocked', 'done', 'cancelled'] },
      },
      TaskAssignee: {
        name: 'assignee',
        in: 'query',
        schema: { type: 'string' },
        description: 'Filter tasks by assignee name',
      },
      ProjectIdQuery: {
        name: 'projectId',
        in: 'query',
        required: true,
        schema: { type: 'string' },
        description: 'Project scope for API key listing/creation',
      },
    },
    schemas: {
      ApiSuccess: {
        type: 'object',
        properties: {
          data: {},
        },
        required: ['data'],
      },
      Paginated: {
        type: 'object',
        properties: {
          data: { type: 'array', items: {} },
          pagination: {
            type: 'object',
            properties: {
              page: { type: 'integer' },
              pageSize: { type: 'integer' },
              total: { type: 'integer' },
              totalPages: { type: 'integer' },
            },
          },
        },
      },
      ApiError: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            properties: {
              code: { type: 'string' },
              message: { type: 'string' },
            },
          },
        },
      },
      CreateProject: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          description: { type: 'string', maxLength: 2000 },
          phase: { type: 'string', enum: ['planning', 'active', 'completed'] },
          repoUrl: { type: 'string', format: 'uri' },
          defaultBranch: { type: 'string' },
        },
      },
      UpdateProject: {
        type: 'object',
        description: 'Partial update (same fields as CreateProject)',
      },
      CreatePlan: {
        type: 'object',
        required: ['title', 'goal', 'scope'],
        properties: {
          title: { type: 'string' },
          goal: { type: 'string' },
          scope: { type: 'string' },
          constraints: { type: 'array', items: { type: 'string' } },
          standards: { type: 'array', items: { type: 'string' } },
          deliverables: { type: 'array', items: { type: 'string' } },
          openQuestions: { type: 'array', items: { type: 'string' } },
          changeSummary: { type: 'string' },
          why: { type: 'string' },
          requiredReviewers: { type: 'array', items: { type: 'string' } },
        },
      },
      UpdatePlan: { type: 'object', description: 'Partial plan draft update' },
      CreateTask: {
        type: 'object',
        required: ['title', 'type'],
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          type: { type: 'string', enum: ['code', 'research', 'design', 'bug', 'refactor'] },
          priority: { type: 'string', enum: ['p0', 'p1', 'p2'] },
          assignee: { type: 'string' },
          assigneeType: { type: 'string', enum: ['human', 'agent', 'unassigned'] },
          branchName: { type: 'string' },
          agentContext: { type: 'string' },
          expectedOutput: { type: 'string' },
          agentConstraints: { type: 'array', items: { type: 'string' } },
        },
      },
      UpdateTask: { type: 'object', description: 'Partial task update' },
      ClaimTask: {
        type: 'object',
        required: ['assigneeType'],
        properties: {
          assigneeType: { type: 'string', enum: ['human', 'agent'] },
        },
      },
      ResolveDrift: {
        type: 'object',
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['rebind', 'cancel', 'no_impact'] },
        },
      },
      CreateSuggestion: {
        type: 'object',
        required: ['field', 'action', 'value', 'reason'],
        properties: {
          field: {
            type: 'string',
            enum: ['goal', 'scope', 'constraints', 'standards', 'deliverables', 'openQuestions'],
          },
          action: { type: 'string', enum: ['set', 'append', 'remove'] },
          value: { type: 'string', minLength: 1 },
          reason: { type: 'string', minLength: 1 },
        },
      },
      CreateComment: {
        type: 'object',
        required: ['content'],
        properties: {
          content: { type: 'string', minLength: 1, maxLength: 10000 },
          parentId: { type: 'string' },
        },
      },
      UpdateComment: {
        type: 'object',
        required: ['content'],
        properties: {
          content: { type: 'string', minLength: 1, maxLength: 10000 },
        },
      },
      ReviewAction: {
        type: 'object',
        properties: {
          comment: { type: 'string' },
        },
      },
      CreateMember: {
        type: 'object',
        required: ['name', 'role', 'type'],
        properties: {
          name: { type: 'string' },
          role: { type: 'string', enum: ['owner', 'developer'] },
          type: { type: 'string', enum: ['human', 'agent'] },
        },
      },
      UpdateMember: {
        type: 'object',
        properties: {
          role: { type: 'string', enum: ['owner', 'developer'] },
        },
      },
      CreateWebhook: {
        type: 'object',
        required: ['url', 'events'],
        properties: {
          url: { type: 'string', format: 'uri' },
          events: { type: 'array', items: { type: 'string' }, minItems: 1 },
          secret: { type: 'string' },
        },
      },
      CreateApiKey: {
        type: 'object',
        required: ['projectId', 'name'],
        properties: {
          projectId: { type: 'string' },
          name: { type: 'string' },
          permissions: { type: 'array', items: { type: 'string' } },
        },
      },
      CreateExecutionRun: {
        type: 'object',
        required: ['taskId', 'executorType', 'executorName'],
        properties: {
          taskId: { type: 'string' },
          executorType: { type: 'string', enum: ['human', 'agent'] },
          executorName: { type: 'string' },
        },
      },
      CompleteExecutionRun: {
        type: 'object',
        required: ['status'],
        properties: {
          status: { type: 'string', enum: ['completed', 'failed'] },
          outputSummary: { type: 'string' },
          filesChanged: { type: 'array', items: { type: 'string' } },
          branchName: { type: 'string' },
          blockers: { type: 'array', items: { type: 'string' } },
          driftSignals: { type: 'array', items: { type: 'string' } },
        },
      },
      Dashboard: {
        type: 'object',
        properties: {
          project: { type: 'object' },
          activePlan: { type: 'object', nullable: true },
          tasks: { type: 'array', items: { type: 'object' } },
          driftAlerts: { type: 'array', items: { type: 'object' } },
          members: { type: 'array', items: { type: 'object' } },
          activities: { type: 'array', items: { type: 'object' } },
        },
      },
      HealthOk: {
        type: 'object',
        properties: {
          status: { type: 'string', example: 'ok' },
          timestamp: { type: 'string', format: 'date-time' },
          database: { type: 'string' },
          sseClients: { type: 'integer' },
        },
      },
    },
  },
  paths: {
    '/health': {
      get: {
        tags: ['Health'],
        summary: 'Health check',
        security: [],
        responses: {
          '200': {
            description: 'Service and database OK',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/HealthOk' } } },
          },
          '503': {
            description: 'Database unavailable',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
    '/projects': {
      get: {
        tags: ['Projects'],
        summary: 'List projects',
        parameters: [
          { $ref: '#/components/parameters/Page' },
          { $ref: '#/components/parameters/PageSize' },
        ],
        responses: {
          '200': {
            description: 'Paginated project list',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Paginated' } } },
          },
        },
      },
      post: {
        tags: ['Projects'],
        summary: 'Create project',
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/CreateProject' } },
          },
        },
        responses: {
          '201': {
            description: 'Project created',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ApiSuccess' } },
            },
          },
        },
      },
    },
    '/projects/{projectId}': {
      get: {
        tags: ['Projects'],
        summary: 'Get project',
        parameters: [{ $ref: '#/components/parameters/ProjectId' }],
        responses: {
          '200': {
            description: 'Project',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ApiSuccess' } },
            },
          },
        },
      },
      patch: {
        tags: ['Projects'],
        summary: 'Update project',
        parameters: [{ $ref: '#/components/parameters/ProjectId' }],
        requestBody: {
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/UpdateProject' } },
          },
        },
        responses: {
          '200': {
            description: 'Updated',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ApiSuccess' } },
            },
          },
        },
      },
      delete: {
        tags: ['Projects'],
        summary: 'Delete project',
        parameters: [{ $ref: '#/components/parameters/ProjectId' }],
        responses: {
          '200': {
            description: 'Deleted',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ApiSuccess' } },
            },
          },
        },
      },
    },
    '/projects/{projectId}/dashboard': {
      get: {
        tags: ['Projects'],
        summary: 'Dashboard aggregation',
        description: 'Project, active plan, tasks, open drifts, members, recent activities',
        parameters: [{ $ref: '#/components/parameters/ProjectId' }],
        responses: {
          '200': {
            description: 'Dashboard payload',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { $ref: '#/components/schemas/Dashboard' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/projects/{projectId}/events': {
      get: {
        tags: ['Projects'],
        summary: 'SSE event stream',
        description: 'Server-Sent Events stream for realtime updates',
        parameters: [{ $ref: '#/components/parameters/ProjectId' }],
        responses: {
          '200': {
            description: 'text/event-stream',
            content: { 'text/event-stream': { schema: { type: 'string' } } },
          },
        },
      },
    },
    '/projects/{projectId}/plans': {
      get: {
        tags: ['Plans'],
        summary: 'List plans',
        parameters: [
          { $ref: '#/components/parameters/ProjectId' },
          { $ref: '#/components/parameters/Page' },
          { $ref: '#/components/parameters/PageSize' },
        ],
        responses: {
          '200': {
            description: 'Paginated plans',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Paginated' } } },
          },
        },
      },
      post: {
        tags: ['Plans'],
        summary: 'Create plan draft',
        parameters: [{ $ref: '#/components/parameters/ProjectId' }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/CreatePlan' } } },
        },
        responses: {
          '201': {
            description: 'Created',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ApiSuccess' } },
            },
          },
        },
      },
    },
    '/projects/{projectId}/plans/active': {
      get: {
        tags: ['Plans'],
        summary: 'Get active plan',
        parameters: [{ $ref: '#/components/parameters/ProjectId' }],
        responses: {
          '200': {
            description: 'Active plan with reviews',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ApiSuccess' } },
            },
          },
          '404': { description: 'No active plan' },
        },
      },
    },
    '/projects/{projectId}/plans/{planId}': {
      get: {
        tags: ['Plans'],
        summary: 'Get plan',
        parameters: [
          { $ref: '#/components/parameters/ProjectId' },
          { $ref: '#/components/parameters/PlanId' },
        ],
        responses: {
          '200': {
            description: 'Plan',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ApiSuccess' } },
            },
          },
        },
      },
      patch: {
        tags: ['Plans'],
        summary: 'Update draft plan',
        parameters: [
          { $ref: '#/components/parameters/ProjectId' },
          { $ref: '#/components/parameters/PlanId' },
        ],
        requestBody: {
          content: { 'application/json': { schema: { $ref: '#/components/schemas/UpdatePlan' } } },
        },
        responses: {
          '200': {
            description: 'Updated',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ApiSuccess' } },
            },
          },
        },
      },
      delete: {
        tags: ['Plans'],
        summary: 'Delete draft plan',
        parameters: [
          { $ref: '#/components/parameters/ProjectId' },
          { $ref: '#/components/parameters/PlanId' },
        ],
        responses: {
          '200': {
            description: 'Deleted',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ApiSuccess' } },
            },
          },
        },
      },
    },
    '/projects/{projectId}/plans/{planId}/activate': {
      post: {
        tags: ['Plans'],
        summary: 'Activate plan',
        description: 'Sets plan active and may create drift alerts for mismatched tasks',
        parameters: [
          { $ref: '#/components/parameters/ProjectId' },
          { $ref: '#/components/parameters/PlanId' },
        ],
        responses: {
          '200': {
            description: 'Activated',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ApiSuccess' } },
            },
          },
        },
      },
    },
    '/projects/{projectId}/plans/{planId}/propose': {
      post: {
        tags: ['Plans'],
        summary: 'Propose plan for review',
        parameters: [
          { $ref: '#/components/parameters/ProjectId' },
          { $ref: '#/components/parameters/PlanId' },
        ],
        responses: {
          '200': {
            description: 'Proposed',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ApiSuccess' } },
            },
          },
        },
      },
    },
    '/projects/{projectId}/plans/{planId}/reactivate': {
      post: {
        tags: ['Plans'],
        summary: 'Reactivate superseded plan',
        parameters: [
          { $ref: '#/components/parameters/ProjectId' },
          { $ref: '#/components/parameters/PlanId' },
        ],
        responses: {
          '200': {
            description: 'Reactivated',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ApiSuccess' } },
            },
          },
        },
      },
    },
    '/projects/{projectId}/plans/{planId}/reviews': {
      get: {
        tags: ['Reviews'],
        summary: 'List plan reviews',
        parameters: [
          { $ref: '#/components/parameters/ProjectId' },
          { $ref: '#/components/parameters/PlanId' },
        ],
        responses: {
          '200': {
            description: 'Reviews',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ApiSuccess' } },
            },
          },
        },
      },
    },
    '/projects/{projectId}/plans/{planId}/reviews/{reviewId}': {
      post: {
        tags: ['Reviews'],
        summary: 'Approve or reject a review',
        description: 'Query: `action=approve` or `action=reject`',
        parameters: [
          { $ref: '#/components/parameters/ProjectId' },
          { $ref: '#/components/parameters/PlanId' },
          { $ref: '#/components/parameters/ReviewId' },
          {
            name: 'action',
            in: 'query',
            required: true,
            schema: { type: 'string', enum: ['approve', 'reject'] },
          },
        ],
        requestBody: {
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ReviewAction' } },
          },
        },
        responses: {
          '200': {
            description: 'Review updated',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ApiSuccess' } },
            },
          },
        },
      },
    },
    '/projects/{projectId}/plans/{planId}/suggestions': {
      get: {
        tags: ['Suggestions'],
        summary: 'List suggestions',
        parameters: [
          { $ref: '#/components/parameters/ProjectId' },
          { $ref: '#/components/parameters/PlanId' },
          { $ref: '#/components/parameters/Page' },
          { $ref: '#/components/parameters/PageSize' },
        ],
        responses: {
          '200': {
            description: 'Paginated suggestions',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Paginated' } } },
          },
        },
      },
      post: {
        tags: ['Suggestions'],
        summary: 'Create suggestion',
        parameters: [
          { $ref: '#/components/parameters/ProjectId' },
          { $ref: '#/components/parameters/PlanId' },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/CreateSuggestion' } },
          },
        },
        responses: {
          '201': {
            description: 'Created',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ApiSuccess' } },
            },
          },
        },
      },
    },
    '/projects/{projectId}/plans/{planId}/suggestions/{suggestionId}': {
      post: {
        tags: ['Suggestions'],
        summary: 'Accept or reject a suggestion',
        description: 'Query: `action=accept` or `action=reject`',
        parameters: [
          { $ref: '#/components/parameters/ProjectId' },
          { $ref: '#/components/parameters/PlanId' },
          { $ref: '#/components/parameters/SuggestionId' },
          {
            name: 'action',
            in: 'query',
            required: true,
            schema: { type: 'string', enum: ['accept', 'reject'] },
          },
        ],
        responses: {
          '200': {
            description: 'Suggestion resolved',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ApiSuccess' } },
            },
          },
        },
      },
    },
    '/projects/{projectId}/plans/{planId}/comments': {
      get: {
        tags: ['Comments'],
        summary: 'List comments',
        parameters: [
          { $ref: '#/components/parameters/ProjectId' },
          { $ref: '#/components/parameters/PlanId' },
          { $ref: '#/components/parameters/Page' },
          { $ref: '#/components/parameters/PageSize' },
        ],
        responses: {
          '200': {
            description: 'Paginated comments',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Paginated' } } },
          },
        },
      },
      post: {
        tags: ['Comments'],
        summary: 'Add comment',
        parameters: [
          { $ref: '#/components/parameters/ProjectId' },
          { $ref: '#/components/parameters/PlanId' },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/CreateComment' } },
          },
        },
        responses: {
          '201': {
            description: 'Created',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ApiSuccess' } },
            },
          },
        },
      },
    },
    '/projects/{projectId}/plans/{planId}/comments/{commentId}': {
      patch: {
        tags: ['Comments'],
        summary: 'Edit comment',
        parameters: [
          { $ref: '#/components/parameters/ProjectId' },
          { $ref: '#/components/parameters/PlanId' },
          { $ref: '#/components/parameters/CommentId' },
        ],
        requestBody: {
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/UpdateComment' } },
          },
        },
        responses: {
          '200': {
            description: 'Updated',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ApiSuccess' } },
            },
          },
        },
      },
      delete: {
        tags: ['Comments'],
        summary: 'Delete comment',
        parameters: [
          { $ref: '#/components/parameters/ProjectId' },
          { $ref: '#/components/parameters/PlanId' },
          { $ref: '#/components/parameters/CommentId' },
        ],
        responses: {
          '200': {
            description: 'Deleted',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ApiSuccess' } },
            },
          },
        },
      },
    },
    '/projects/{projectId}/tasks': {
      get: {
        tags: ['Tasks'],
        summary: 'List tasks',
        parameters: [
          { $ref: '#/components/parameters/ProjectId' },
          { $ref: '#/components/parameters/Page' },
          { $ref: '#/components/parameters/PageSize' },
          { $ref: '#/components/parameters/TaskStatus' },
          { $ref: '#/components/parameters/TaskAssignee' },
        ],
        responses: {
          '200': {
            description: 'Paginated tasks',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Paginated' } } },
          },
        },
      },
      post: {
        tags: ['Tasks'],
        summary: 'Create task',
        parameters: [{ $ref: '#/components/parameters/ProjectId' }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateTask' } } },
        },
        responses: {
          '201': {
            description: 'Created',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ApiSuccess' } },
            },
          },
        },
      },
    },
    '/projects/{projectId}/tasks/{taskId}': {
      get: {
        tags: ['Tasks'],
        summary: 'Get task',
        parameters: [
          { $ref: '#/components/parameters/ProjectId' },
          { $ref: '#/components/parameters/TaskId' },
        ],
        responses: {
          '200': {
            description: 'Task',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ApiSuccess' } },
            },
          },
        },
      },
      patch: {
        tags: ['Tasks'],
        summary: 'Update task',
        parameters: [
          { $ref: '#/components/parameters/ProjectId' },
          { $ref: '#/components/parameters/TaskId' },
        ],
        requestBody: {
          content: { 'application/json': { schema: { $ref: '#/components/schemas/UpdateTask' } } },
        },
        responses: {
          '200': {
            description: 'Updated',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ApiSuccess' } },
            },
          },
        },
      },
      delete: {
        tags: ['Tasks'],
        summary: 'Delete task',
        parameters: [
          { $ref: '#/components/parameters/ProjectId' },
          { $ref: '#/components/parameters/TaskId' },
        ],
        responses: {
          '200': {
            description: 'Deleted',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ApiSuccess' } },
            },
          },
        },
      },
    },
    '/projects/{projectId}/tasks/{taskId}/claim': {
      post: {
        tags: ['Tasks'],
        summary: 'Claim task',
        parameters: [
          { $ref: '#/components/parameters/ProjectId' },
          { $ref: '#/components/parameters/TaskId' },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ClaimTask' } } },
        },
        responses: {
          '200': {
            description: 'Claimed',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ApiSuccess' } },
            },
          },
        },
      },
    },
    '/projects/{projectId}/tasks/{taskId}/rebind': {
      post: {
        tags: ['Tasks'],
        summary: 'Rebind task to active plan',
        parameters: [
          { $ref: '#/components/parameters/ProjectId' },
          { $ref: '#/components/parameters/TaskId' },
        ],
        responses: {
          '200': {
            description: 'Rebound',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ApiSuccess' } },
            },
          },
        },
      },
    },
    '/projects/{projectId}/tasks/{taskId}/pack': {
      get: {
        tags: ['Tasks'],
        summary: 'Get task pack for execution',
        parameters: [
          { $ref: '#/components/parameters/ProjectId' },
          { $ref: '#/components/parameters/TaskId' },
        ],
        responses: {
          '200': {
            description: 'Task pack JSON',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ApiSuccess' } },
            },
          },
        },
      },
    },
    '/projects/{projectId}/tasks/{taskId}/runs': {
      get: {
        tags: ['Tasks'],
        summary: 'List execution runs',
        parameters: [
          { $ref: '#/components/parameters/ProjectId' },
          { $ref: '#/components/parameters/TaskId' },
          { $ref: '#/components/parameters/Page' },
          { $ref: '#/components/parameters/PageSize' },
        ],
        responses: {
          '200': {
            description: 'Paginated runs',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Paginated' } } },
          },
        },
      },
      post: {
        tags: ['Tasks'],
        summary: 'Start execution run',
        parameters: [
          { $ref: '#/components/parameters/ProjectId' },
          { $ref: '#/components/parameters/TaskId' },
        ],
        requestBody: {
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/CreateExecutionRun' } },
          },
        },
        responses: {
          '201': {
            description: 'Started',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ApiSuccess' } },
            },
          },
        },
      },
    },
    '/projects/{projectId}/tasks/{taskId}/runs/{runId}': {
      post: {
        tags: ['Tasks'],
        summary: 'Heartbeat or complete execution run',
        description:
          'Query `action=heartbeat` (no body) or `action=complete` with `CompleteExecutionRun` body',
        parameters: [
          { $ref: '#/components/parameters/ProjectId' },
          { $ref: '#/components/parameters/TaskId' },
          { $ref: '#/components/parameters/RunId' },
          {
            name: 'action',
            in: 'query',
            required: true,
            schema: { type: 'string', enum: ['heartbeat', 'complete'] },
          },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CompleteExecutionRun' },
            },
          },
        },
        responses: {
          '200': {
            description: 'Run updated',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ApiSuccess' } },
            },
          },
        },
      },
    },
    '/projects/{projectId}/drifts': {
      get: {
        tags: ['Drift'],
        summary: 'List drift alerts',
        parameters: [
          { $ref: '#/components/parameters/ProjectId' },
          { $ref: '#/components/parameters/Page' },
          { $ref: '#/components/parameters/PageSize' },
          { $ref: '#/components/parameters/DriftStatus' },
        ],
        responses: {
          '200': {
            description: 'Paginated drifts',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Paginated' } } },
          },
        },
      },
    },
    '/projects/{projectId}/drifts/{driftId}': {
      post: {
        tags: ['Drift'],
        summary: 'Resolve drift alert',
        parameters: [
          { $ref: '#/components/parameters/ProjectId' },
          { $ref: '#/components/parameters/DriftId' },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ResolveDrift' } },
          },
        },
        responses: {
          '200': {
            description: 'Resolved',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ApiSuccess' } },
            },
          },
        },
      },
    },
    '/projects/{projectId}/members': {
      get: {
        tags: ['Members'],
        summary: 'List members',
        parameters: [{ $ref: '#/components/parameters/ProjectId' }],
        responses: {
          '200': {
            description: 'Members',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ApiSuccess' } },
            },
          },
        },
      },
      post: {
        tags: ['Members'],
        summary: 'Add member',
        parameters: [{ $ref: '#/components/parameters/ProjectId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/CreateMember' } },
          },
        },
        responses: {
          '201': {
            description: 'Added',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ApiSuccess' } },
            },
          },
        },
      },
    },
    '/projects/{projectId}/members/{memberId}': {
      patch: {
        tags: ['Members'],
        summary: 'Update member',
        parameters: [
          { $ref: '#/components/parameters/ProjectId' },
          { $ref: '#/components/parameters/MemberId' },
        ],
        requestBody: {
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/UpdateMember' } },
          },
        },
        responses: {
          '200': {
            description: 'Updated',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ApiSuccess' } },
            },
          },
        },
      },
      delete: {
        tags: ['Members'],
        summary: 'Remove member',
        parameters: [
          { $ref: '#/components/parameters/ProjectId' },
          { $ref: '#/components/parameters/MemberId' },
        ],
        responses: {
          '200': {
            description: 'Removed',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ApiSuccess' } },
            },
          },
        },
      },
    },
    '/projects/{projectId}/activities': {
      get: {
        tags: ['Activities'],
        summary: 'List activities',
        parameters: [
          { $ref: '#/components/parameters/ProjectId' },
          { $ref: '#/components/parameters/Page' },
          { $ref: '#/components/parameters/PageSize' },
        ],
        responses: {
          '200': {
            description: 'Paginated activities',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Paginated' } } },
          },
        },
      },
    },
    '/projects/{projectId}/webhooks': {
      get: {
        tags: ['Webhooks'],
        summary: 'List webhooks',
        parameters: [{ $ref: '#/components/parameters/ProjectId' }],
        responses: {
          '200': {
            description: 'Webhooks',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ApiSuccess' } },
            },
          },
        },
      },
      post: {
        tags: ['Webhooks'],
        summary: 'Register webhook',
        parameters: [{ $ref: '#/components/parameters/ProjectId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/CreateWebhook' } },
          },
        },
        responses: {
          '201': {
            description: 'Registered',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ApiSuccess' } },
            },
          },
        },
      },
    },
    '/webhooks/{webhookId}': {
      delete: {
        tags: ['Webhooks'],
        summary: 'Delete webhook',
        parameters: [{ $ref: '#/components/parameters/WebhookId' }],
        responses: {
          '200': {
            description: 'Deleted',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ApiSuccess' } },
            },
          },
        },
      },
    },
    '/webhooks/{webhookId}/test': {
      post: {
        tags: ['Webhooks'],
        summary: 'Send test delivery',
        parameters: [{ $ref: '#/components/parameters/WebhookId' }],
        responses: {
          '200': {
            description: 'Test queued or sent',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ApiSuccess' } },
            },
          },
        },
      },
    },
    '/webhooks/{webhookId}/deliveries': {
      get: {
        tags: ['Webhooks'],
        summary: 'List webhook deliveries',
        parameters: [{ $ref: '#/components/parameters/WebhookId' }],
        responses: {
          '200': {
            description: 'Deliveries',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ApiSuccess' } },
            },
          },
        },
      },
    },
    '/auth/api-keys': {
      get: {
        tags: ['Auth'],
        summary: 'List API keys for a project',
        parameters: [{ $ref: '#/components/parameters/ProjectIdQuery' }],
        responses: {
          '200': {
            description: 'Key metadata (no raw secrets)',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ApiSuccess' } },
            },
          },
        },
      },
      post: {
        tags: ['Auth'],
        summary: 'Create API key',
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/CreateApiKey' } },
          },
        },
        responses: {
          '201': {
            description: 'Created; `key` is only returned once',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ApiSuccess' } },
            },
          },
        },
      },
    },
    '/auth/api-keys/{keyId}': {
      delete: {
        tags: ['Auth'],
        summary: 'Revoke API key',
        parameters: [{ $ref: '#/components/parameters/KeyId' }],
        responses: {
          '200': {
            description: 'Revoked',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ApiSuccess' } },
            },
          },
        },
      },
    },
  },
} as const;
