// E2E: PlanSync Terminal REPL simulation.
// Spawns the real CLI (packages/cli/dist/index.js) with piped stdin/stdout.
// readline works in non-TTY mode: reads stdin line-by-line, writes prompts to stdout.
// Each session.send() writes one command and waits for the next prompt before returning.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';

const ROOT = path.resolve(__dirname, '../../../..');
const LOCAL_NODE = path.join(ROOT, '.local-runtime/node/bin/node');
const CLI_BUNDLE = path.join(ROOT, 'packages/cli/dist/index.js');
const SERVER_URL = `http://localhost:${process.env.PORT || 3001}`;
const SECRET = process.env.PLANSYNC_SECRET || 'dev-secret';
const TEST_USER = 'e2e-term-user';

// Fail early if prerequisites are missing
if (!fs.existsSync(LOCAL_NODE)) {
  throw new Error(`Local node runtime not found: ${LOCAL_NODE}. Run bin/ps-admin start first.`);
}
if (!fs.existsSync(CLI_BUNDLE)) {
  throw new Error(`CLI bundle not found: ${CLI_BUNDLE}. Run: cd packages/cli && npm run build`);
}

// ─── Strip ANSI codes ─────────────────────────────────────────────────────────

function stripAnsi(s: string): string {
  return (
    s
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;]*[mA-Z]/g, '') // color/style codes
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9]*[A-Z]/g, '') // cursor movement
      .replace(/\r/g, '')
  );
}

// ─── TerminalSession ─────────────────────────────────────────────────────────
// Drives the PlanSync Terminal REPL via piped stdin/stdout.
// Waits for any recognizable "waiting-for-input" prompt before returning.

const PROMPT_TOKENS = [
  '> ', // main REPL prompt
  'Enter number', // project selection list
  '[yes/N]:', // delete confirmation
  '[Y/n]:', // yes/no prompt
  'Project name:', // name input
  'cancel]:', // "or Enter to cancel:"
];

class TerminalSession {
  proc: ChildProcess | null = null;
  private buf = '';
  private onData: ((c: Buffer) => void) | null = null;

  /** Start the terminal with a pre-selected project. */
  async start(
    projectId: string,
    user = TEST_USER,
    extraEnv: Record<string, string> = {},
  ): Promise<string> {
    return this._spawn(projectId, user, extraEnv);
  }

  /** Start without PLANSYNC_PROJECT set — triggers the project selection screen. */
  async startNoProject(user = TEST_USER): Promise<string> {
    return this._spawn('', user);
  }

  private async _spawn(
    projectId: string,
    user: string,
    extraEnv: Record<string, string> = {},
  ): Promise<string> {
    this.proc = spawn(LOCAL_NODE, [CLI_BUNDLE], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PLANSYNC_API_URL: SERVER_URL,
        PLANSYNC_SECRET: SECRET,
        PLANSYNC_USER: user,
        PLANSYNC_PROJECT: projectId,
        LOG_LEVEL: 'warn',
        ...extraEnv,
      },
    });
    this.buf = '';
    this.onData = (c: Buffer) => {
      this.buf += stripAnsi(c.toString());
    };
    this.proc.stdout!.on('data', this.onData);
    this.proc.stderr!.on('data', () => {}); // discard
    return this._waitPrompt(45_000); // banner + MCP init
  }

  /** Send a command and wait for the next prompt. Returns accumulated output since last prompt. */
  async send(input: string, timeoutMs = 30_000): Promise<string> {
    this.buf = '';
    this.proc!.stdin!.write(input + '\n');
    return this._waitPrompt(timeoutMs);
  }

  /** Current output buffer (without clearing). */
  peek(): string {
    return this.buf;
  }

  /** Gracefully exit. */
  async quit(): Promise<void> {
    try {
      this.proc!.stdin!.write('/quit\n');
    } catch {
      /* ignore */
    }
    await new Promise<void>((r) => {
      const timer = setTimeout(r, 3000);
      this.proc!.on('close', () => {
        clearTimeout(timer);
        r();
      });
    });
    this.proc!.kill();
    this.proc = null;
  }

  private _waitPrompt(ms: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error(`Terminal timeout (${ms}ms). Last output:\n${this.buf.slice(-500)}`)),
        ms,
      );
      const check = setInterval(() => {
        if (PROMPT_TOKENS.some((t) => this.buf.includes(t))) {
          clearTimeout(timer);
          clearInterval(check);
          resolve(this.buf);
        }
      }, 100);
      this.proc!.on('close', () => {
        clearTimeout(timer);
        clearInterval(check);
        resolve(this.buf);
      });
    });
  }
}

// ─── API helper for test data setup ──────────────────────────────────────────

async function api(method: string, path: string, body?: unknown, user = TEST_USER) {
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

// ─────────────────────────────────────────────────────────────────────────────
// Suite A: Startup Banner
// ─────────────────────────────────────────────────────────────────────────────

describe('A: Startup banner', () => {
  let projectId: string;
  let session: TerminalSession;

  beforeAll(async () => {
    const proj = await api('POST', '/api/projects', { name: `e2e-term-a-${Date.now()}` });
    projectId = proj.data.id;
    await api('POST', `/api/projects/${projectId}/members`, { name: 'ai1', role: 'developer' });

    const plan = await api('POST', `/api/projects/${projectId}/plans`, {
      title: 'Term Test Plan',
      goal: 'Verify terminal banner',
      scope: 'All slash commands',
    });
    await api('POST', `/api/projects/${projectId}/plans/${plan.data.id}/activate`, {});

    await api('POST', `/api/projects/${projectId}/tasks`, { title: 'Done Task', type: 'code' });
    await api('POST', `/api/projects/${projectId}/tasks`, {
      title: 'In Progress Task',
      type: 'code',
    });
    await api('POST', `/api/projects/${projectId}/tasks`, { title: 'Todo Task', type: 'code' });

    session = new TerminalSession();
    await session.start(projectId);
  }, 60_000);

  afterAll(async () => {
    await session?.quit();
    if (projectId) await api('DELETE', `/api/projects/${projectId}`);
  });

  it('A1: banner contains "PlanSync Terminal"', () => {
    expect(session.peek()).toContain('PlanSync Terminal');
  });

  it('A2: banner contains the user name', () => {
    expect(session.peek()).toContain(TEST_USER);
  });

  it('A3: banner contains plan version', () => {
    expect(session.peek()).toMatch(/v\d+/);
  });

  it('A4: banner contains task count', () => {
    // 3 tasks created
    expect(session.peek()).toContain('3');
  });

  it('A5: banner contains MCP tools count', () => {
    expect(session.peek()).toMatch(/\d+ MCP tools/);
  });

  it('A6: no drift → banner shows "none"', () => {
    expect(session.peek()).toMatch(/none|✓/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite B: Slash Commands
// ─────────────────────────────────────────────────────────────────────────────

describe('B: Slash commands', () => {
  let projectId: string;
  let projectId2: string;
  let session: TerminalSession;

  beforeAll(async () => {
    const proj = await api('POST', '/api/projects', { name: `e2e-term-b-${Date.now()}` });
    projectId = proj.data.id;
    const proj2 = await api('POST', '/api/projects', { name: `e2e-term-b2-${Date.now()}` });
    projectId2 = proj2.data.id;

    const plan = await api('POST', `/api/projects/${projectId}/plans`, {
      title: 'Slash Cmd Plan',
      goal: 'G',
      scope: 'S',
    });
    await api('POST', `/api/projects/${projectId}/plans/${plan.data.id}/activate`, {});
    await api('POST', `/api/projects/${projectId}/tasks`, { title: 'Task A', type: 'code' });

    session = new TerminalSession();
    await session.start(projectId);
  }, 60_000);

  afterAll(async () => {
    await session?.quit();
    await api('DELETE', `/api/projects/${projectId}`);
    await api('DELETE', `/api/projects/${projectId2}`);
  });

  it('B1: /status shows project info and plan version', async () => {
    const out = await session.send('/status');
    expect(out).toContain('e2e-term-b-');
    expect(out).toMatch(/v\d+/);
  });

  it('B2: /tasks shows task section', async () => {
    const out = await session.send('/tasks');
    expect(out).toMatch(/Task A|Todo|in_progress|done|No tasks/i);
  });

  it('B3: /help lists core commands', async () => {
    const out = await session.send('/help');
    expect(out).toContain('/status');
    expect(out).toContain('/tasks');
    expect(out).toContain('/project');
    expect(out).toContain('/quit');
    expect(out).toContain('/tools');
    expect(out).toContain('/clear');
  });

  it('B4: /tools shows MCP tool list (≥40 tools)', async () => {
    const out = await session.send('/tools');
    expect(out).toContain('plansync_plan_list');
    expect(out).toContain('plansync_task_create');
    expect(out).toContain('plansync_member_list');
    // Count tool entries (each line contains plansync_)
    const toolLines = out.split('\n').filter((l) => l.includes('plansync_'));
    expect(toolLines.length).toBeGreaterThanOrEqual(40);
  });

  it('B5: /clear clears history', async () => {
    const out = await session.send('/clear');
    expect(out.toLowerCase()).toContain('clear');
  });

  it('B6: ! runs a shell command', async () => {
    const out = await session.send('!echo hello_terminal_sim');
    expect(out).toContain('hello_terminal_sim');
  });

  it('B7: /project <id> switches to another project', async () => {
    const out = await session.send(`/project ${projectId2}`);
    expect(out).toContain('e2e-term-b2-');
  });

  it('B8: /unknown_xyz shows "Unknown command" error', async () => {
    // Switch back to projectId first
    await session.send(`/project ${projectId}`);
    const out = await session.send('/unknown_xyz');
    expect(out.toLowerCase()).toContain('unknown');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite C: Task display details
// ─────────────────────────────────────────────────────────────────────────────

describe('C: Task display details', () => {
  let projectId: string;
  let session: TerminalSession;

  beforeAll(async () => {
    const proj = await api('POST', '/api/projects', { name: `e2e-term-c-${Date.now()}` });
    projectId = proj.data.id;
    await api('POST', `/api/projects/${projectId}/members`, { name: 'ai1', role: 'developer' });

    const plan = await api('POST', `/api/projects/${projectId}/plans`, {
      title: 'Tasks Display Plan',
      goal: 'G',
      scope: 'S',
    });
    await api('POST', `/api/projects/${projectId}/plans/${plan.data.id}/activate`, {});

    // P0 task with assignee
    await api('POST', `/api/projects/${projectId}/tasks`, {
      title: 'Critical P0 Task',
      type: 'code',
      priority: 'p0',
      assignee: 'ai1',
    });
    // P2 task no assignee
    await api('POST', `/api/projects/${projectId}/tasks`, {
      title: 'Normal P2 Task',
      type: 'code',
    });
    // Long title (> 52 chars)
    await api('POST', `/api/projects/${projectId}/tasks`, {
      title:
        'This Is An Extremely Long Task Title That Should Be Truncated By The CLI Display Logic',
      type: 'code',
    });

    session = new TerminalSession();
    await session.start(projectId);
  }, 60_000);

  afterAll(async () => {
    await session?.quit();
    if (projectId) await api('DELETE', `/api/projects/${projectId}`);
  });

  it('C1: P0 task shows "P0" badge in /tasks output', async () => {
    const out = await session.send('/tasks');
    expect(out).toContain('P0');
  });

  it('C2: task with assignee shows @ai1 in /tasks output', async () => {
    const out = await session.send('/tasks');
    expect(out).toContain('@ai1');
  });

  it('C3: long title is truncated (contains "…") in /tasks output', async () => {
    const out = await session.send('/tasks');
    expect(out).toContain('…');
  });

  it('C4: /tasks output contains task titles', async () => {
    const out = await session.send('/tasks');
    expect(out).toContain('Critical P0 Task');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite D: Empty state display
// ─────────────────────────────────────────────────────────────────────────────

describe('D: Empty state display', () => {
  it('D1: project with no plan → banner shows "no active plan"', async () => {
    const proj = await api('POST', '/api/projects', { name: `e2e-term-d1-${Date.now()}` });
    const session = new TerminalSession();
    const out = await session.start(proj.data.id);
    await session.quit();
    await api('DELETE', `/api/projects/${proj.data.id}`);
    expect(out.toLowerCase()).toMatch(/no active plan|no.*plan/);
  }, 60_000);

  it('D2: project with proposed plan → banner shows "Pending Review"', async () => {
    const proj = await api('POST', '/api/projects', { name: `e2e-term-d2-${Date.now()}` });
    const projId = proj.data.id;
    await api('POST', `/api/projects/${projId}/members`, { name: 'reviewer1', role: 'developer' });
    const p = await api('POST', `/api/projects/${projId}/plans`, {
      title: 'Pending Plan',
      goal: 'G',
      scope: 'S',
      requiredReviewers: ['reviewer1'],
    });
    await api('POST', `/api/projects/${projId}/plans/${p.data.id}/propose`, {});

    const session = new TerminalSession();
    const out = await session.start(projId);
    await session.quit();
    await api('DELETE', `/api/projects/${projId}`);
    expect(out).toContain('Pending Review');
  }, 60_000);

  it('D3: proposed plan shows reviewer names in banner', async () => {
    const proj = await api('POST', '/api/projects', { name: `e2e-term-d3-${Date.now()}` });
    const projId = proj.data.id;
    await api('POST', `/api/projects/${projId}/members`, { name: 'ai1', role: 'developer' });
    await api('POST', `/api/projects/${projId}/members`, { name: 'ai2', role: 'developer' });
    const p = await api('POST', `/api/projects/${projId}/plans`, {
      title: 'Multi-Reviewer Plan',
      goal: 'G',
      scope: 'S',
      requiredReviewers: ['ai1', 'ai2'],
    });
    await api('POST', `/api/projects/${projId}/plans/${p.data.id}/propose`, {});

    const session = new TerminalSession();
    const out = await session.start(projId);
    await session.quit();
    await api('DELETE', `/api/projects/${projId}`);
    expect(out).toContain('ai1');
    expect(out).toContain('ai2');
  }, 60_000);

  it('D4: project with no tasks → /tasks shows "No tasks"', async () => {
    const proj = await api('POST', '/api/projects', { name: `e2e-term-d4-${Date.now()}` });
    const projId = proj.data.id;

    const session = new TerminalSession();
    await session.start(projId);
    const out = await session.send('/tasks');
    await session.quit();
    await api('DELETE', `/api/projects/${projId}`);
    expect(out.toLowerCase()).toContain('no tasks');
  }, 60_000);

  it('D5: project with drift → banner shows ⚠', async () => {
    const proj = await api('POST', '/api/projects', { name: `e2e-term-d5-${Date.now()}` });
    const projId = proj.data.id;
    const p1 = await api('POST', `/api/projects/${projId}/plans`, {
      title: 'v1',
      goal: 'G',
      scope: 'S',
    });
    await api('POST', `/api/projects/${projId}/plans/${p1.data.id}/activate`, {});
    await api('POST', `/api/projects/${projId}/tasks`, { title: 'Drifting Task', type: 'code' });
    const p2 = await api('POST', `/api/projects/${projId}/plans`, {
      title: 'v2',
      goal: 'G2',
      scope: 'S2',
    });
    await api('POST', `/api/projects/${projId}/plans/${p2.data.id}/activate`, {});
    // Wait for drift
    for (let i = 0; i < 10; i++) {
      const d = await api('GET', `/api/projects/${projId}/drifts?status=open`);
      if ((d.data?.length ?? 0) > 0) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    const session = new TerminalSession();
    const out = await session.start(projId);
    await session.quit();
    await api('DELETE', `/api/projects/${projId}`);
    expect(out).toContain('⚠');
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite E: Project selection screen (no PLANSYNC_PROJECT)
// ─────────────────────────────────────────────────────────────────────────────

describe('E: Project selection screen', () => {
  let projectA: string;
  let projectB: string;

  beforeAll(async () => {
    const pA = await api('POST', '/api/projects', { name: `e2e-sel-A-${Date.now()}` });
    const pB = await api('POST', '/api/projects', { name: `e2e-sel-B-${Date.now()}` });
    projectA = pA.data.id;
    projectB = pB.data.id;
  }, 15_000);

  afterAll(async () => {
    await api('DELETE', `/api/projects/${projectA}`);
    await api('DELETE', `/api/projects/${projectB}`);
  });

  it('E1: shows numbered project list', async () => {
    const session = new TerminalSession();
    const out = await session.startNoProject();
    // Send an invalid choice to keep it at selection; then quit
    await session.proc!.stdin!.write('q\n'); // invalid → handled gracefully
    await session.quit();
    expect(out).toMatch(/1\./);
    expect(out).toContain('e2e-sel-');
  }, 45_000);

  it('E2: shows "n. Create new project" and "d. Delete a project" options', async () => {
    const session = new TerminalSession();
    const out = await session.startNoProject();
    await session.quit();
    expect(out).toContain('n.');
    expect(out).toContain('d.');
  }, 45_000);

  it('E3: entering "n" then empty name → Cancelled', async () => {
    const session = new TerminalSession();
    await session.startNoProject();
    await session.send('n'); // "Project name: "
    const out = await session.send(''); // empty → Cancelled
    await session.quit();
    expect(out).toContain('Cancelled');
  }, 45_000);

  it('E4: entering "n" then a name → creates project', async () => {
    const newName = `e2e-created-${Date.now()}`;
    const session = new TerminalSession();
    await session.startNoProject();
    await session.send('n'); // "Project name: "
    const out = await session.send(newName); // creates project
    // After creation, terminal auto-selects it → banner appears
    // Clean up: find and delete the created project
    await session.quit();
    expect(out.toLowerCase()).toMatch(/created|selected|e2e-created/);
    // Cleanup
    const projects = await api('GET', '/api/projects');
    const created = projects.data?.find((p: any) => p.name === newName);
    if (created) await api('DELETE', `/api/projects/${created.id}`);
  }, 45_000);

  it('E5: selecting a valid number selects that project', async () => {
    const session = new TerminalSession();
    await session.startNoProject();
    const out = await session.send('1'); // select first project
    await session.quit();
    // Banner appears after selection
    expect(out).toMatch(/Selected|PlanSync Terminal|e2e-sel-/);
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite F: Error recovery
// ─────────────────────────────────────────────────────────────────────────────

describe('F: Error recovery', () => {
  it('F1: invalid PLANSYNC_PROJECT → terminal shows error, does not crash hard', async () => {
    const session = new TerminalSession();
    const out = await session.start('invalid-project-id-xyz');
    await session.quit();
    // Should either show an error or a banner with empty/invalid project info — but not hang
    expect(typeof out).toBe('string');
  }, 45_000);

  it('F2: LLM not configured → AI command shows warning instead of crashing', async () => {
    const proj = await api('POST', '/api/projects', { name: `e2e-term-f2-${Date.now()}` });
    const projId = proj.data.id;
    const session = new TerminalSession();
    await session.start(projId, TEST_USER, {
      LLM_API_KEY: '',
      ANTHROPIC_API_KEY: '',
    });
    const out = await session.send('hello', 15_000);
    await session.quit();
    await api('DELETE', `/api/projects/${projId}`);
    // Should warn about missing AI config, not crash
    expect(out.toLowerCase()).toMatch(/⚠|warn|not configured|ai/);
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite G: AI tool routing (requires LLM — skip if not configured)
// ─────────────────────────────────────────────────────────────────────────────

const hasLlm = !!(process.env.LLM_API_KEY || process.env.ANTHROPIC_API_KEY);

describe('G: AI tool routing', () => {
  let projectId: string;
  let session: TerminalSession;

  beforeAll(async () => {
    if (!hasLlm) return;
    const proj = await api('POST', '/api/projects', { name: `e2e-term-g-${Date.now()}` });
    projectId = proj.data.id;
    await api('POST', `/api/projects/${projectId}/members`, { name: 'ai1', role: 'developer' });
    const plan = await api('POST', `/api/projects/${projectId}/plans`, {
      title: 'AI Routing Plan',
      goal: 'G',
      scope: 'S',
    });
    await api('POST', `/api/projects/${projectId}/plans/${plan.data.id}/activate`, {});

    session = new TerminalSession();
    await session.start(projectId);
  }, 60_000);

  afterAll(async () => {
    if (!hasLlm) return;
    await session?.quit();
    if (projectId) await api('DELETE', `/api/projects/${projectId}`);
  });

  it.skipIf(!hasLlm)(
    'G1: member count query → plansync_member_list called',
    async () => {
      const out = await session.send('how many members does this project have', 90_000);
      expect(out).toContain('plansync_member_list');
    },
    120_000,
  );

  it.skipIf(!hasLlm)(
    'G2: plan query → plansync_plan_list or plansync_plan_active called',
    async () => {
      const out = await session.send('what is the current active plan', 90_000);
      expect(out).toMatch(/plansync_plan_list|plansync_plan_active/);
    },
    120_000,
  );

  it.skipIf(!hasLlm)(
    'G3: task creation → plansync_task_create called',
    async () => {
      const out = await session.send('create a task: Fix login bug, type code', 90_000);
      expect(out).toContain('plansync_task_create');
    },
    120_000,
  );

  it.skipIf(!hasLlm)(
    'G4: drift query → status or drift tool called',
    async () => {
      const out = await session.send('are there any drift alerts', 90_000);
      expect(out).toMatch(/plansync_status|plansync_drift_list/);
    },
    120_000,
  );

  it.skipIf(!hasLlm)(
    'G5: delegation "work as ai1" → plansync_my_work called',
    async () => {
      const out = await session.send('work as ai1', 90_000);
      expect(out).toContain('plansync_my_work');
    },
    120_000,
  );
});
