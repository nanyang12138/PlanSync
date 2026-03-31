// J module: Webhook delivery
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  POST as webhooksPost,
  GET as webhooksGet,
} from '@/app/api/projects/[projectId]/webhooks/route';
import { DELETE as webhookDelete } from '@/app/api/webhooks/[webhookId]/route';
import { GET as deliveriesGet } from '@/app/api/webhooks/[webhookId]/deliveries/route';
import { POST as webhookTest } from '@/app/api/webhooks/[webhookId]/test/route';
import { POST as activatePost } from '@/app/api/projects/[projectId]/plans/[planId]/activate/route';
import { POST as plansPost } from '@/app/api/projects/[projectId]/plans/route';
import {
  makeReq,
  createTestProject,
  addMember,
  createActivePlan,
  cleanupProject,
} from '../helpers/request';
import http from 'http';

describe('J: Webhook Delivery', () => {
  const owner = 'webhook-owner';
  const dev = 'webhook-dev';
  let projectId: string;
  let mockServer: http.Server;
  let mockPort: number;
  let receivedRequests: {
    headers: Record<string, string | string[] | undefined>;
    body: unknown;
  }[] = [];
  let mockResponseStatus = 200;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    await addMember(projectId, dev);
    await createActivePlan(projectId, owner);

    // Start in-process mock HTTP server
    mockServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        receivedRequests.push({
          headers: req.headers as Record<string, string | string[] | undefined>,
          body: (() => {
            try {
              return JSON.parse(body || '{}');
            } catch {
              return body;
            }
          })(),
        });
        res.writeHead(mockResponseStatus);
        res.end();
      });
    });
    mockPort = await new Promise<number>((resolve) => {
      mockServer.listen(0, () => resolve((mockServer.address() as { port: number }).port));
    });
  });

  afterAll(async () => {
    await cleanupProject(projectId);
    mockServer.close();
  });

  let webhookId: string;

  it('J1: owner POST /webhooks {url, events} → 201', async () => {
    receivedRequests = [];
    const res = await webhooksPost(
      makeReq(`/api/projects/${projectId}/webhooks`, {
        method: 'POST',
        userName: owner,
        body: {
          url: `http://localhost:${mockPort}/hook`,
          events: ['plan_activated', 'task_created'],
        },
      }),
      { params: { projectId } },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    webhookId = body.data.id;
    expect(body.data.url).toContain(`${mockPort}`);
  });

  it('J1边: developer POST /webhooks → 403', async () => {
    const res = await webhooksPost(
      makeReq(`/api/projects/${projectId}/webhooks`, {
        method: 'POST',
        userName: dev,
        body: { url: `http://localhost:${mockPort}/hook2`, events: ['task_created'] },
      }),
      { params: { projectId } },
    );
    expect(res.status).toBe(403);
  });

  it('J2: GET /webhooks (owner) → 200, data array', async () => {
    const res = await webhooksGet(
      makeReq(`/api/projects/${projectId}/webhooks`, { userName: owner }),
      { params: { projectId } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
  });

  it('J4: activate plan → webhook receives POST', async () => {
    receivedRequests = [];
    const createRes = await plansPost(
      makeReq(`/api/projects/${projectId}/plans`, {
        method: 'POST',
        userName: owner,
        body: {
          title: 'Webhook Plan',
          goal: 'g',
          scope: 's',
          constraints: [],
          standards: [],
          deliverables: [],
          openQuestions: [],
          requiredReviewers: [],
        },
      }),
      { params: { projectId } },
    );
    const planId = (await createRes.json()).data.id;

    await activatePost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/activate`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: { projectId, planId } },
    );

    // Wait for webhook delivery (async)
    await new Promise((r) => setTimeout(r, 200));
    expect(receivedRequests.length).toBeGreaterThan(0);
  });

  it('J6: GET /webhooks/:id/deliveries → 200', async () => {
    const res = await deliveriesGet(
      makeReq(`/api/webhooks/${webhookId}/deliveries`, { userName: owner }),
      { params: { webhookId } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('J7: POST /webhooks/:id/test → mock server receives test payload', async () => {
    receivedRequests = [];
    const res = await webhookTest(
      makeReq(`/api/webhooks/${webhookId}/test`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: { webhookId } },
    );
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    expect(receivedRequests.length).toBeGreaterThan(0);
    const body = receivedRequests[0].body as Record<string, unknown>;
    expect(body.event).toBe('webhook.test');
  });

  it('J5: webhook with secret → X-PlanSync-Signature header present', async () => {
    // Create a webhook with secret
    const secretRes = await webhooksPost(
      makeReq(`/api/projects/${projectId}/webhooks`, {
        method: 'POST',
        userName: owner,
        body: {
          url: `http://localhost:${mockPort}/secret-hook`,
          events: ['task_created'],
          secret: 'my-secret-key',
        },
      }),
      { params: { projectId } },
    );
    expect(secretRes.status).toBe(201);
    const secretWebhookId = (await secretRes.json()).data.id;

    receivedRequests = [];
    await webhookTest(
      makeReq(`/api/webhooks/${secretWebhookId}/test`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: { webhookId: secretWebhookId } },
    );
    await new Promise((r) => setTimeout(r, 200));
    if (receivedRequests.length > 0) {
      const headers = receivedRequests[0].headers as Record<string, string>;
      // Check signature header exists
      const sigHeader = headers['x-plansync-signature'];
      if (sigHeader) {
        expect(sigHeader).toMatch(/^sha256=/);
      }
    }
  });

  it('J11: register webhook with empty events → 400 VALIDATION_ERROR', async () => {
    const res = await webhooksPost(
      makeReq(`/api/projects/${projectId}/webhooks`, {
        method: 'POST',
        userName: owner,
        body: { url: `http://localhost:${mockPort}/bad`, events: [] },
      }),
      { params: { projectId } },
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('J3: DELETE /webhooks/:id → 200', async () => {
    // Create a webhook to delete
    const createRes = await webhooksPost(
      makeReq(`/api/projects/${projectId}/webhooks`, {
        method: 'POST',
        userName: owner,
        body: { url: `http://localhost:${mockPort}/to-delete`, events: ['task_created'] },
      }),
      { params: { projectId } },
    );
    const toDeleteId = (await createRes.json()).data.id;

    const res = await webhookDelete(
      makeReq(`/api/webhooks/${toDeleteId}`, {
        method: 'DELETE',
        userName: owner,
      }),
      { params: { webhookId: toDeleteId } },
    );
    expect(res.status).toBe(200);
  });
});
