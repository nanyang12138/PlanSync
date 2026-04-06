// E2E: Web page rendering verification via HTTP fetch.
// Tests that Next.js Server Components render correct data in HTML.
// No browser automation needed — pages are server-side rendered (SSR).
//
// Auth: Send Cookie: plansync-user=<username> header. The middleware converts this
// to x-user-name internally (works with AUTH_DISABLED=true).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const SERVER_URL = `http://localhost:${process.env.PORT || 3001}`;
const SECRET = process.env.PLANSYNC_SECRET || 'dev-secret';
const WEB_USER = 'e2e-web-user';
const OTHER_USER = 'e2e-web-other';

// API helper (admin/data setup)
async function api(method: string, path: string, body?: unknown, user = WEB_USER) {
  const r = await fetch(`${SERVER_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${SECRET}`,
      'X-User-Name': user,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json: any = {};
  try {
    json = await r.json();
  } catch {
    /* ignore */
  }
  return { status: r.status, data: json.data };
}

// Web page fetch — simulates a browser session (cookie-based auth)
async function page(path: string, user = WEB_USER) {
  const r = await fetch(`${SERVER_URL}${path}`, {
    headers: {
      Cookie: `plansync-user=${user}`,
      Accept: 'text/html,application/xhtml+xml',
    },
    redirect: 'manual', // don't follow redirects automatically
  });
  return {
    status: r.status,
    html: await r.text().catch(() => ''),
    location: r.headers.get('location'),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test data
// ─────────────────────────────────────────────────────────────────────────────

let projectId: string;
let planTitle: string;
let otherProjectId: string;

beforeAll(async () => {
  planTitle = `E2E Web Plan ${Date.now()}`;

  // Main project: active plan + tasks + members
  const proj = await api('POST', '/api/projects', {
    name: `e2e-web-project-${Date.now()}`,
    description: 'E2E web simulation test project',
  });
  projectId = proj.data.id;

  // Add a member
  await api('POST', `/api/projects/${projectId}/members`, { name: 'ai1', role: 'developer' });

  // Create and activate a plan
  const plan = await api('POST', `/api/projects/${projectId}/plans`, {
    title: planTitle,
    goal: 'Verify web page rendering for E2E tests',
    scope: 'All web pages that display project data',
    deliverables: ['Confirmed correct HTML output'],
  });
  await api('POST', `/api/projects/${projectId}/plans/${plan.data.id}/activate`, {});

  // Create tasks
  await api('POST', `/api/projects/${projectId}/tasks`, { title: 'Web Test Task 1', type: 'code' });
  await api('POST', `/api/projects/${projectId}/tasks`, {
    title: 'Web Test Task 2',
    type: 'review',
    assignee: 'ai1',
  });

  // Second project for OTHER_USER (WEB_USER should not see its content)
  const other = await api(
    'POST',
    '/api/projects',
    { name: `e2e-web-other-${Date.now()}` },
    OTHER_USER,
  );
  otherProjectId = other.data.id;
}, 45_000);

afterAll(async () => {
  if (projectId) await api('DELETE', `/api/projects/${projectId}`);
  if (otherProjectId) await api('DELETE', `/api/projects/${otherProjectId}`, undefined, OTHER_USER);
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite W1: Home page (/)
// ─────────────────────────────────────────────────────────────────────────────

describe('W1: Home page (/)', () => {
  it('W1-1: returns 200', async () => {
    const { status } = await page('/');
    expect(status).toBe(200);
  });

  it('W1-2: contains PlanSync brand', async () => {
    const { html } = await page('/');
    expect(html).toContain('PlanSync');
  });

  it('W1-3: contains the test project name', async () => {
    const { html } = await page('/');
    expect(html).toContain('e2e-web-project');
  });

  it('W1-4: contains link to project page', async () => {
    const { html } = await page('/');
    expect(html).toContain(`/projects/${projectId}`);
  });

  it("W1-5: WEB_USER does not see OTHER_USER's project", async () => {
    const { html } = await page('/');
    // The other project was created by OTHER_USER, WEB_USER is not a member
    expect(html).not.toContain(`/projects/${otherProjectId}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite W2: Project dashboard (/projects/:id)
// ─────────────────────────────────────────────────────────────────────────────

describe('W2: Project dashboard (/projects/:id)', () => {
  it('W2-1: returns 200', async () => {
    const { status } = await page(`/projects/${projectId}`);
    expect(status).toBe(200);
  });

  it('W2-2: contains project name', async () => {
    const { html } = await page(`/projects/${projectId}`);
    expect(html).toContain('e2e-web-project');
  });

  it('W2-3: contains active plan title', async () => {
    const { html } = await page(`/projects/${projectId}`);
    expect(html).toContain(planTitle);
  });

  it('W2-4: contains task-related content', async () => {
    const { html } = await page(`/projects/${projectId}`);
    expect(html.toLowerCase()).toMatch(/task/);
  });

  it('W2-5: contains member ai1', async () => {
    const { html } = await page(`/projects/${projectId}`);
    expect(html).toContain('ai1');
  });

  it('W2-6: contains plan version indicator', async () => {
    const { html } = await page(`/projects/${projectId}`);
    // Active plan version is shown (v1 format)
    expect(html).toMatch(/v\d+/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite W3: Drift display on web
// ─────────────────────────────────────────────────────────────────────────────

describe('W3: Drift alerts on project dashboard', () => {
  let driftProjectId: string;

  beforeAll(async () => {
    // Create project → v1 → task → v2 (triggers drift)
    const proj = await api('POST', '/api/projects', { name: `e2e-web-drift-${Date.now()}` });
    driftProjectId = proj.data.id;

    const p1 = await api('POST', `/api/projects/${driftProjectId}/plans`, {
      title: 'Web v1',
      goal: 'G',
      scope: 'S',
    });
    await api('POST', `/api/projects/${driftProjectId}/plans/${p1.data.id}/activate`, {});

    await api('POST', `/api/projects/${driftProjectId}/tasks`, {
      title: 'Drifting Task',
      type: 'code',
    });

    const p2 = await api('POST', `/api/projects/${driftProjectId}/plans`, {
      title: 'Web v2',
      goal: 'G2',
      scope: 'S2',
    });
    await api('POST', `/api/projects/${driftProjectId}/plans/${p2.data.id}/activate`, {});

    // Wait for drift
    for (let i = 0; i < 10; i++) {
      const d = await api('GET', `/api/projects/${driftProjectId}/drifts?status=open`);
      if ((d.data?.length ?? 0) > 0) break;
      await new Promise((r) => setTimeout(r, 500));
    }
  }, 30_000);

  afterAll(async () => {
    if (driftProjectId) await api('DELETE', `/api/projects/${driftProjectId}`);
  });

  it('W3-1: project dashboard shows drift-related content when drift exists', async () => {
    const { status, html } = await page(`/projects/${driftProjectId}`);
    expect(status).toBe(200);
    // Drift is shown in the dashboard
    expect(html.toLowerCase()).toMatch(/drift|alert|warning/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite W4: Plan status variations
// ─────────────────────────────────────────────────────────────────────────────

describe('W4: Plan status variations on project dashboard', () => {
  let noplanProjectId: string;
  let proposedProjectId: string;

  beforeAll(async () => {
    // Project with no plan
    const np = await api('POST', '/api/projects', { name: `e2e-web-noplan-${Date.now()}` });
    noplanProjectId = np.data.id;

    // Project with proposed plan
    const pp = await api('POST', '/api/projects', { name: `e2e-web-proposed-${Date.now()}` });
    proposedProjectId = pp.data.id;
    await api('POST', `/api/projects/${proposedProjectId}/members`, {
      name: 'reviewer1',
      role: 'developer',
    });
    const plan = await api('POST', `/api/projects/${proposedProjectId}/plans`, {
      title: 'Proposed Plan',
      goal: 'G',
      scope: 'S',
      requiredReviewers: ['reviewer1'],
    });
    await api('POST', `/api/projects/${proposedProjectId}/plans/${plan.data.id}/propose`, {});
  }, 30_000);

  afterAll(async () => {
    if (noplanProjectId) await api('DELETE', `/api/projects/${noplanProjectId}`);
    if (proposedProjectId) await api('DELETE', `/api/projects/${proposedProjectId}`);
  });

  it('W4-1: project with no plan still renders (200)', async () => {
    const { status, html } = await page(`/projects/${noplanProjectId}`);
    expect(status).toBe(200);
    expect(html).toContain('PlanSync');
  });

  it('W4-2: project with proposed plan shows review-related content', async () => {
    const { status, html } = await page(`/projects/${proposedProjectId}`);
    expect(status).toBe(200);
    // Should contain plan title or review status
    expect(html).toContain('Proposed Plan');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite W5: Edge cases and error handling
// ─────────────────────────────────────────────────────────────────────────────

describe('W5: Edge cases', () => {
  it('W5-1: /api/health returns { status: "ok" }', async () => {
    const r = await fetch(`${SERVER_URL}/api/health`);
    expect(r.status).toBe(200);
    const json = await r.json();
    expect(json.status).toBe('ok');
  });

  it('W5-2: non-existent project → not 200 (404 or redirect)', async () => {
    const { status } = await page('/projects/nonexistent-id-xyz');
    expect(status).not.toBe(200);
  });

  it('W5-3: /login page is accessible without auth', async () => {
    const r = await fetch(`${SERVER_URL}/login`, {
      headers: { Accept: 'text/html' },
      redirect: 'manual',
    });
    // Either 200 (login page) or redirect to itself — not a crash
    expect([200, 302, 307, 308]).toContain(r.status);
  });

  it('W5-4: home page with no cookie still responds (AUTH_DISABLED mode)', async () => {
    const r = await fetch(`${SERVER_URL}/`, {
      headers: { Accept: 'text/html' },
      redirect: 'manual',
    });
    // In AUTH_DISABLED mode should be 200 (auto-sets default user)
    // In auth mode would redirect to /login
    expect([200, 302, 307]).toContain(r.status);
  });

  it('W5-5: project page returns 200 (access control enforced at API layer, not web page layer)', async () => {
    // Web pages render via Prisma directly — access control is at the API route level (tested in api-boundary P8).
    // The web page will render 200; if the user is not a member, the API calls from the browser will fail.
    const { status } = await page(`/projects/${otherProjectId}`);
    expect(status).toBe(200);
  });
});
