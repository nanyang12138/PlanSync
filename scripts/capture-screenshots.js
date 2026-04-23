#!/usr/bin/env node
// Capture README screenshots for PlanSync.
// Produces:
//   docs/img/dashboard.png    — owner project dashboard
//   docs/img/drift-alert.png  — task page with drift alert
//   docs/img/plan-diff.png    — plan history / diff view
//
// Requires playwright (auto-installed by scripts/record-demo.sh).

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE_URL = process.env.PLANSYNC_API_URL || 'http://localhost:3001';
const OUT_DIR = path.resolve(__dirname, '..', 'docs', 'img');
const SUFFIX = `shots-${Date.now()}`;
const ALICE = `alice-${SUFFIX}`;
const BOB = `bob-${SUFFIX}`;
const CHARLIE = `charlie-${SUFFIX}`;
const PW = 'ShotPass#' + Math.random().toString(16).slice(2, 6);

async function pause(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function apiAs(user, pw, method, p, body = null) {
  const res = await fetch(`${BASE_URL}${p}`, {
    method,
    headers: {
      Authorization: `Bearer ${pw}`,
      'X-User-Name': user,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try { return { status: res.status, data: JSON.parse(text) }; }
  catch { return { status: res.status, data: text }; }
}

async function login(page, user, pw) {
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[placeholder="your-name"]', user);
  await page.fill('input[type="password"]', pw);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.toString().includes('/login'), { timeout: 15000 });
  await pause(1500);
}

async function gotoStable(page, url, settleMs = 2500) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // SSE keeps the connection open → never reaches networkidle.
  // Wait for DOM + a settle period instead.
  await pause(settleMs);
}

async function shoot(page, name) {
  const out = path.join(OUT_DIR, name);
  await page.screenshot({ path: out, fullPage: false });
  const sz = (fs.statSync(out).size / 1024).toFixed(1);
  console.log(`  ✓ ${name}  (${sz} KB)`);
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`\n  PlanSync README screenshot capture`);
  console.log(`  ─────────────────────────────────────────`);
  console.log(`  Base URL:  ${BASE_URL}`);
  console.log(`  Output:    ${OUT_DIR}\n`);

  // ── Set up demo data ─────────────────────────────────────────────────────
  process.stdout.write('  Seeding demo data...');
  for (const u of [ALICE, BOB, CHARLIE]) {
    const r = await apiAs(u, PW, 'POST', '/api/auth/register', { userName: u, password: PW });
    if (r.status !== 200 && r.status !== 201) {
      const lr = await apiAs(u, PW, 'POST', '/api/auth/login', { userName: u, password: PW });
      if (lr.status !== 200) { console.error(`\n  cannot register/login ${u}:`, lr.data); process.exit(1); }
    }
  }

  const projRes = await apiAs(ALICE, PW, 'POST', '/api/projects', {
    name: `auth-module-${SUFFIX}`,
    description: 'OAuth2 + OIDC integration for the customer portal',
  });
  const projId = projRes.data?.data?.id;
  if (!projId) { console.error('\n  failed to create project:', projRes.data); process.exit(1); }

  await apiAs(ALICE, PW, 'POST', `/api/projects/${projId}/members`,
    { name: BOB, role: 'developer', type: 'human' });
  await apiAs(ALICE, PW, 'POST', `/api/projects/${projId}/members`,
    { name: CHARLIE, role: 'developer', type: 'human' });

  // Plan v1
  const planRes = await apiAs(ALICE, PW, 'POST', `/api/projects/${projId}/plans`, {
    title: 'Auth Module — Phase 1',
    goal: 'Implement JWT-based authentication with refresh tokens and session management',
    scope: 'Login endpoint, token refresh, logout, session store',
    constraints: [
      'Stateless: no server-side sessions',
      'JWT access token expiry: 15 minutes',
      'Refresh tokens stored httpOnly + secure cookies',
    ],
    deliverables: [
      'POST /auth/login',
      'POST /auth/refresh',
      'POST /auth/logout',
      'Unit tests with >80% coverage',
    ],
  });
  const planId = planRes.data?.data?.id || planRes.data?.id;
  if (!planId) { console.error('\n  plan create response:', planRes.status, JSON.stringify(planRes.data).slice(0, 400)); process.exit(1); }
  const proposeR = await apiAs(ALICE, PW, 'POST', `/api/projects/${projId}/plans/${planId}/propose`, { reviewers: [BOB] });
  if (proposeR.status >= 400) console.error('  propose:', proposeR.status, JSON.stringify(proposeR.data));
  const reviewsRes = await apiAs(ALICE, PW, 'GET', `/api/projects/${projId}/plans/${planId}/reviews`);
  const reviewId = reviewsRes.data?.data?.[0]?.id;
  if (reviewId) {
    const apR = await apiAs(BOB, PW, 'POST',
      `/api/projects/${projId}/plans/${planId}/reviews/${reviewId}?action=approve`,
      { comment: 'Scope and constraints look solid. Approved.' });
    if (apR.status >= 400) console.error('  approve:', apR.status, JSON.stringify(apR.data));
  }
  const activateR = await apiAs(ALICE, PW, 'POST', `/api/projects/${projId}/plans/${planId}/activate`, {});
  if (activateR.status >= 400) console.error('  activate:', activateR.status, JSON.stringify(activateR.data));

  // Tasks
  const t1 = await apiAs(ALICE, PW, 'POST', `/api/projects/${projId}/tasks`, {
    title: 'Implement POST /auth/login endpoint',
    type: 'code', assignee: CHARLIE, assigneeType: 'human',
  });
  const task1Id = t1.data?.data?.id;
  if (!task1Id) { console.error('\n  failed to create task:', JSON.stringify(t1.data)); process.exit(1); }
  await apiAs(ALICE, PW, 'POST', `/api/projects/${projId}/tasks`, {
    title: 'Implement token refresh & logout',
    type: 'code', assignee: CHARLIE, assigneeType: 'human',
  });
  await apiAs(ALICE, PW, 'POST', `/api/projects/${projId}/tasks`, {
    title: 'Research: JWT secret rotation best practices',
    type: 'research', assignee: BOB, assigneeType: 'human',
  });

  // Charlie starts execution → ensures HIGH-severity drift later
  const runRes = await apiAs(CHARLIE, PW, 'POST', `/api/projects/${projId}/tasks/${task1Id}/runs`, {
    executorType: 'human', executorName: CHARLIE,
  });
  const runId = runRes.data?.data?.id;

  // Plan v2 — triggers drift
  const plan2Res = await apiAs(ALICE, PW, 'POST', `/api/projects/${projId}/plans`, {
    title: 'Auth Module — Phase 1 (Revised, +MFA)',
    goal: 'JWT auth with refresh tokens, session management, AND optional TOTP-based MFA',
    scope: 'Login, refresh, logout, session store, MFA enrollment + verification',
    constraints: [
      'Stateless JWT, 15min expiry',
      'MFA must be opt-in per user',
      'TOTP only (no SMS)',
      'MFA setup requires a fresh login within 5 minutes',
    ],
    deliverables: [
      'POST /auth/login',
      'POST /auth/refresh',
      'POST /auth/logout',
      'POST /auth/mfa/setup',
      'POST /auth/mfa/verify',
      'Unit + integration tests',
    ],
  });
  const plan2Id = plan2Res.data?.data?.id || plan2Res.data?.id;
  if (!plan2Id) { console.error('\n  plan2 create:', plan2Res.status, JSON.stringify(plan2Res.data).slice(0, 400)); process.exit(1); }
  await apiAs(ALICE, PW, 'POST', `/api/projects/${projId}/plans/${plan2Id}/propose`, { reviewers: [BOB] });
  const r2 = await apiAs(ALICE, PW, 'GET', `/api/projects/${projId}/plans/${plan2Id}/reviews`);
  const review2Id = r2.data?.data?.[0]?.id;
  if (review2Id) {
    await apiAs(BOB, PW, 'POST',
      `/api/projects/${projId}/plans/${plan2Id}/reviews/${review2Id}?action=approve`,
      { comment: 'MFA scope addition looks good. Approved.' });
  }
  await apiAs(ALICE, PW, 'POST', `/api/projects/${projId}/plans/${plan2Id}/activate`, {});
  console.log(' done\n');

  // Give SSE / drift engine a moment
  await pause(1500);

  // ── Browser ─────────────────────────────────────────────────────────────
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  // Login as CHARLIE — he has assigned tasks + drift, so dashboard shows real state
  await login(page, CHARLIE, PW);

  // ── 1. Dashboard (Charlie's project list with drift badges) ──────────────
  console.log('  Capturing screenshots:');
  await gotoStable(page, `${BASE_URL}/`, 3500);
  await shoot(page, 'dashboard.png');

  // ── 2. Drift alert — task detail page (Charlie's task is bound to v1) ────
  await gotoStable(page, `${BASE_URL}/projects/${projId}/tasks/${task1Id}`, 3500);
  await shoot(page, 'drift-alert.png');

  // ── 3. Plan history / diff view ──────────────────────────────────────────
  await gotoStable(page, `${BASE_URL}/projects/${projId}/plans`, 3500);
  await shoot(page, 'plan-diff.png');

  await ctx.close();
  await browser.close();

  // ── Cleanup ─────────────────────────────────────────────────────────────
  process.stdout.write('\n  Cleaning up demo project...');
  await apiAs(ALICE, PW, 'DELETE', `/api/projects/${projId}`).catch(() => {});
  console.log(' done\n');

  console.log('  ─────────────────────────────────────────');
  console.log(`  Saved 3 screenshots to: ${path.relative(process.cwd(), OUT_DIR)}/`);
  console.log('  ─────────────────────────────────────────\n');
})().catch((err) => {
  console.error('\n  Error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
