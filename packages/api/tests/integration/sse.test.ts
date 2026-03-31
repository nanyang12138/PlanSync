// I module: SSE (Server-Sent Events)
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GET as eventsGet } from '@/app/api/projects/[projectId]/events/route';
import { POST as tasksPost } from '@/app/api/projects/[projectId]/tasks/route';
import { POST as activatePost } from '@/app/api/projects/[projectId]/plans/[planId]/activate/route';
import { POST as plansPost } from '@/app/api/projects/[projectId]/plans/route';
import { POST as membersPost } from '@/app/api/projects/[projectId]/members/route';
import {
  makeReq,
  createTestProject,
  addMember,
  createActivePlan,
  cleanupProject,
  testPrisma,
} from '../helpers/request';

describe('I: SSE (Server-Sent Events)', () => {
  const owner = 'sse-owner';
  const dev = 'sse-dev';
  let projectId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    await addMember(projectId, dev);
    await createActivePlan(projectId, owner);
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  async function connectSSE() {
    const res = await eventsGet(makeReq(`/api/projects/${projectId}/events`, { userName: owner }), {
      params: { projectId },
    });
    const reader = res.body!.getReader();
    // Read the initial connected chunk
    const { value: initChunk } = await reader.read();
    const initText = new TextDecoder().decode(initChunk);
    return { res, reader, initText };
  }

  async function readNextEvent(reader: ReadableStreamDefaultReader<Uint8Array>) {
    const { value } = await reader.read();
    return new TextDecoder().decode(value);
  }

  it('I1: GET /events → 200, text/event-stream', async () => {
    const res = await eventsGet(makeReq(`/api/projects/${projectId}/events`, { userName: owner }), {
      params: { projectId },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    await res.body!.cancel();
  });

  it('I1边: first chunk is `: connected\\n\\n`', async () => {
    const { reader, initText } = await connectSSE();
    expect(initText).toBe(': connected\n\n');
    await reader.cancel();
  });

  it('I4: POST /tasks → SSE pushes task_created', async () => {
    const { reader, initText } = await connectSSE();
    expect(initText).toBe(': connected\n\n');

    await tasksPost(
      makeReq(`/api/projects/${projectId}/tasks`, {
        method: 'POST',
        userName: owner,
        body: { title: 'SSE Task', type: 'code' },
      }),
      { params: { projectId } },
    );

    const eventText = await readNextEvent(reader);
    expect(eventText).toContain('event: task_created');
    await reader.cancel();
  });

  it('I2: activate plan → SSE pushes plan_activated', async () => {
    // Create a draft plan first
    const createRes = await plansPost(
      makeReq(`/api/projects/${projectId}/plans`, {
        method: 'POST',
        userName: owner,
        body: {
          title: 'SSE Plan',
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

    const { reader, initText } = await connectSSE();
    expect(initText).toBe(': connected\n\n');

    await activatePost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/activate`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: { projectId, planId } },
    );

    const eventText = await readNextEvent(reader);
    expect(eventText).toContain('event: plan_activated');
    await reader.cancel();
  });

  it('I11: POST member → SSE pushes member_added', async () => {
    const { reader, initText } = await connectSSE();
    expect(initText).toBe(': connected\n\n');

    await membersPost(
      makeReq(`/api/projects/${projectId}/members`, {
        method: 'POST',
        userName: owner,
        body: { name: 'sse-new-member', role: 'developer', type: 'human' },
      }),
      { params: { projectId } },
    );

    const eventText = await readNextEvent(reader);
    expect(eventText).toContain('event: member_added');
    await reader.cancel();
  });

  it('I15: project A SSE does not receive project B events', async () => {
    const { projectId: projBId } = await createTestProject('sse-b-owner');
    await createActivePlan(projBId, 'sse-b-owner');

    const { reader, initText } = await connectSSE(); // connected to project A
    expect(initText).toBe(': connected\n\n');

    // Trigger event in project B
    await tasksPost(
      makeReq(`/api/projects/${projBId}/tasks`, {
        method: 'POST',
        userName: 'sse-b-owner',
        body: { title: 'B Task', type: 'code' },
      }),
      { params: { projectId: projBId } },
    );

    // Project A stream should NOT receive this. We verify by checking the stream is not immediately ready.
    // Use a race: if we can read a chunk within a very short time, something's wrong.
    let gotEvent = false;
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 50));
    const readPromise = reader.read().then(() => {
      gotEvent = true;
    });
    await timeout;
    expect(gotEvent).toBe(false);

    await reader.cancel();
    await cleanupProject(projBId);
  });
});
