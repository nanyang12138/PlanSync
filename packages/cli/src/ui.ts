import * as readline from 'readline';

// ─── Startup splash animation ─────────────────────────────────────────────────

// 6-line ASCII banner — width 70 cols. Falls back to a compact box on narrow terminals.
const BANNER_LINES = [
  '██████╗ ██╗      █████╗ ███╗   ██╗███████╗██╗   ██╗███╗   ██╗ ██████╗',
  '██╔══██╗██║     ██╔══██╗████╗  ██║██╔════╝╚██╗ ██╔╝████╗  ██║██╔════╝',
  '██████╔╝██║     ███████║██╔██╗ ██║███████╗ ╚████╔╝ ██╔██╗ ██║██║     ',
  '██╔═══╝ ██║     ██╔══██║██║╚██╗██║╚════██║  ╚██╔╝  ██║╚██╗██║██║     ',
  '██║     ███████╗██║  ██║██║ ╚████║███████║   ██║   ██║ ╚████║╚██████╗',
  '╚═╝     ╚══════╝╚═╝  ╚═╝╚═╝  ╚═══╝╚══════╝   ╚═╝   ╚═╝  ╚═══╝ ╚═════╝',
];
const BANNER_WIDTH = 70;
const TAGLINE = 'Where Plans Meet Execution';

export async function showSplash(): Promise<void> {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const termCols = process.stdout.columns || 80;

  // Clear screen and show animated spinner for ~400ms
  process.stdout.write('\x1b[2J\x1b[H'); // clear screen, cursor to top
  await new Promise<void>((resolve) => {
    let i = 0;
    const t = setInterval(() => {
      const f = frames[i % frames.length];
      process.stdout.write(`\r  \x1b[34m${f}\x1b[0m  \x1b[1mPlanSync Terminal\x1b[0m  `);
      i++;
      if (i >= 8) {
        clearInterval(t);
        resolve();
      }
    }, 50);
  });
  process.stdout.write('\r' + ' '.repeat(40) + '\r');

  // Wide terminal → big ASCII banner (left-aligned, 2-space indent like the rest of the UI).
  // Narrow → compact box.
  if (termCols >= BANNER_WIDTH + 4) {
    const indent = '  ';
    process.stdout.write('\n');
    for (const line of BANNER_LINES) {
      process.stdout.write(`${indent}\x1b[35m\x1b[1m${line}\x1b[0m\n`);
    }
    process.stdout.write(`${indent}\x1b[2m${TAGLINE}\x1b[0m\n\n`);
  } else {
    const cols = Math.min(termCols, 60);
    const inner = cols - 4;
    const title = 'PlanSync Terminal';
    const pad = Math.max(0, inner - title.length);
    const lp = Math.floor(pad / 2);
    const rp = Math.ceil(pad / 2);
    process.stdout.write(`\n  \x1b[34m\x1b[1m╭${'─'.repeat(inner + 2)}╮\x1b[0m\n`);
    process.stdout.write(
      `  \x1b[34m\x1b[1m│\x1b[0m ${' '.repeat(lp)}\x1b[1m${title}\x1b[0m${' '.repeat(rp)} \x1b[34m\x1b[1m│\x1b[0m\n`,
    );
    process.stdout.write(`  \x1b[34m\x1b[1m╰${'─'.repeat(inner + 2)}╯\x1b[0m\n\n`);
  }
}

// ─── Colors ───────────────────────────────────────────────────────────────────

export const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  violet: '\x1b[35m',
  gray: '\x1b[90m',
};

// ─── Spinner ──────────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function createSpinner(message: string) {
  let i = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  const startTime = Date.now();

  const elapsed = () => {
    const s = Math.floor((Date.now() - startTime) / 1000);
    return s > 0 ? (s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`) : '';
  };

  return {
    start() {
      timer = setInterval(() => {
        const t = elapsed();
        process.stdout.write(
          `\r${c.blue}${SPINNER_FRAMES[i % SPINNER_FRAMES.length]}${c.reset} ${message}${t ? ` ${c.dim}(${t})${c.reset}` : ''}  `,
        );
        i++;
      }, 80);
    },
    stop(finalMessage?: string) {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      process.stdout.write('\r' + ' '.repeat(80) + '\r');
      if (finalMessage) process.stdout.write(finalMessage + '\n');
    },
    done(message: string) {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      process.stdout.write('\r' + ' '.repeat(80) + '\r');
      process.stdout.write(`${c.green}✔${c.reset} ${message}\n`);
    },
    fail(message: string) {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      process.stdout.write('\r' + ' '.repeat(80) + '\r');
      process.stdout.write(`${c.red}✘${c.reset} ${message}\n`);
    },
  };
}

// ─── Tool call block display ──────────────────────────────────────────────────

export function printToolStart(name: string, input: Record<string, unknown>): void {
  const args = Object.entries(input)
    .map(([k, v]) => {
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      return `${c.dim}${k}${c.reset}=${c.cyan}${s.length > 60 ? s.slice(0, 57) + '…' : s}${c.reset}`;
    })
    .join('  ');
  process.stdout.write(`\n  ${c.dim}╭─${c.reset} ${c.violet}${name}${c.reset}\n`);
  if (args) process.stdout.write(`  ${c.dim}│${c.reset}  ${args}\n`);
}

export function printToolDone(result: string, ms: number): void {
  const lines = result.split('\n');
  const MAX = 5;
  if (lines.length > MAX) {
    for (const l of lines.slice(0, MAX)) {
      process.stdout.write(`  ${c.dim}│  ${l}${c.reset}\n`);
    }
    process.stdout.write(`  ${c.dim}│  [truncated — ${lines.length} lines total]${c.reset}\n`);
  }
  process.stdout.write(`  ${c.dim}╰─${c.reset} ${c.green}✔${c.reset} ${c.dim}${ms}ms${c.reset}\n`);
}

export function printToolCompact(name: string, ms: number): void {
  process.stdout.write(
    `  ${c.dim}✔ ${c.reset}${c.violet}${name}${c.reset}${c.dim}  ${ms}ms${c.reset}\n`,
  );
}

export function printToolError(message: string, ms: number): void {
  const short = message.length > 120 ? message.slice(0, 117) + '…' : message;
  process.stdout.write(
    `  ${c.dim}╰─${c.reset} ${c.red}✘${c.reset} ${short}  ${c.dim}${ms}ms${c.reset}\n`,
  );
}

// ─── Progress bar ─────────────────────────────────────────────────────────────

export function progressBar(done: number, total: number, width = 10): string {
  if (total === 0) return '░'.repeat(width);
  const filled = Math.round((done / total) * width);
  return `${c.green}${'█'.repeat(filled)}${c.reset}${c.dim}${'░'.repeat(width - filled)}${c.reset}`;
}

// ─── Project status types ─────────────────────────────────────────────────────

export interface ProjectStatus {
  projectId: string;
  projectName: string;
  phase: string;
  activePlan: { version: number; title: string; goal: string } | null;
  proposedPlan: {
    version: number;
    title: string;
    reviews: { reviewer: string; status: string }[];
  } | null;
  draftPlan: { version: number; title: string } | null;
  tasks: { total: number; done: number; inProgress: number; todo: number; blocked: number };
  taskList: {
    id: string;
    title: string;
    status: string;
    assignee: string | null;
    priority: string;
  }[];
  driftAlerts: {
    id: string;
    taskTitle: string;
    severity: string;
    reason: string;
    assignee: string | null;
  }[];
}

export function emptyStatus(projectId = '', projectName = '(no project)'): ProjectStatus {
  return {
    projectId,
    projectName,
    phase: 'planning',
    activePlan: null,
    proposedPlan: null,
    draftPlan: null,
    tasks: { total: 0, done: 0, inProgress: 0, todo: 0, blocked: 0 },
    taskList: [],
    driftAlerts: [],
  };
}

// ─── Phase indicator ─────────────────────────────────────────────────────────

function phaseIndicator(phase: string): string {
  const phases: Array<'planning' | 'active' | 'completed'> = ['planning', 'active', 'completed'];
  const colors: Record<string, string> = { planning: c.dim, active: c.cyan, completed: c.green };
  return phases
    .map((p) =>
      p === phase ? `${colors[p] ?? c.cyan}${c.bold}[${p}]${c.reset}` : `${c.dim}${p}${c.reset}`,
    )
    .join(` ${c.dim}→${c.reset} `);
}

function nextStep(status: ProjectStatus): string {
  if (status.phase === 'completed') {
    return `${c.dim}Project closed — type "reopen project" to continue${c.reset}`;
  }
  if (status.driftAlerts.length > 0) {
    return `${c.yellow}⚠ Resolve drift before continuing${c.reset}  ${c.dim}→ type "resolve drift"${c.reset}`;
  }
  if (!status.activePlan && !status.proposedPlan && !status.draftPlan) {
    return `${c.cyan}Type: "create a plan: <one-line goal>"${c.reset}`;
  }
  if (status.draftPlan && !status.proposedPlan && !status.activePlan) {
    return `${c.cyan}Draft v${status.draftPlan.version} — type "propose plan" to submit for review${c.reset}`;
  }
  if (status.proposedPlan && !status.activePlan) {
    return `${c.cyan}Type: "review plan v${status.proposedPlan.version}"${c.reset}`;
  }
  const t = status.tasks;
  if (t.total === 0) {
    return `${c.cyan}Type: "create tasks for this plan"${c.reset}`;
  }
  if (t.done === t.total) {
    return `${c.green}All done — type "close project"${c.reset}`;
  }
  if (t.inProgress > 0) {
    return `${c.cyan}Type: "/tasks" to see what's in progress${c.reset}`;
  }
  return `${c.cyan}Type: "/tasks" to pick a task and start${c.reset}`;
}

// ─── Banner (two-column layout) ──────────────────────────────────────────────

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function padTo(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - stripAnsi(s).length));
}

function truncateAnsi(s: string, maxVis: number): string {
  if (stripAnsi(s).length <= maxVis) return s;
  let vis = 0,
    i = 0,
    result = '';
  while (i < s.length && vis < maxVis - 1) {
    if (s[i] === '\x1b') {
      const end = s.indexOf('m', i);
      if (end !== -1) {
        result += s.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    result += s[i++];
    vis++;
  }
  return result + `…${c.reset}`;
}

const REVIEW_ICON: Record<string, string> = {
  approved: `${c.green}✓${c.reset}`,
  rejected: `${c.red}✗${c.reset}`,
  pending: `${c.dim}○${c.reset}`,
};

export function banner(
  status: ProjectStatus,
  _toolCount: number,
  user: string,
  recentActivity: Array<{ text: string; urgent?: boolean; ts: number }> = [],
) {
  const cols = process.stdout.columns || 80;
  const rightInner = 27;
  // Left box inner width; cap at 45 for readability, min 20 before degraded
  const leftInner = Math.min(45, cols - rightInner - 10);

  // ── Degraded (narrow terminal) ─────────────────────────────────────────────
  if (leftInner < 20) {
    console.log('');
    console.log(`  ${c.bold}${c.cyan}PlanSync Terminal${c.reset}  ${c.dim}${user}${c.reset}`);
    console.log(`  ${c.bold}${status.projectName}${c.reset}  ${phaseIndicator(status.phase)}`);
    console.log(`  ${c.yellow}▸${c.reset}  ${nextStep(status)}`);
    console.log('');
    return;
  }

  // ── Left column rows ───────────────────────────────────────────────────────
  let planLine: string;
  if (status.activePlan) {
    const maxTitle = leftInner - 6;
    const t = status.activePlan.title;
    const title = t.length > maxTitle ? t.slice(0, maxTitle - 1) + '…' : t;
    planLine = `${c.cyan}v${status.activePlan.version}${c.reset}  ${c.dim}"${title}"${c.reset}`;
  } else if (status.proposedPlan) {
    const p = status.proposedPlan;
    const allApproved = p.reviews.length > 0 && p.reviews.every((r) => r.status === 'approved');
    const label = allApproved
      ? `${c.green}Ready to Activate${c.reset}`
      : `${c.yellow}Pending Review${c.reset}`;
    const reviewStr =
      p.reviews.length > 0
        ? '  ' +
          p.reviews
            .map((r) => `${c.dim}${r.reviewer}${c.reset} ${REVIEW_ICON[r.status] ?? '○'}`)
            .join('  ')
        : '';
    planLine = `${label}  v${p.version}${reviewStr}`;
  } else if (status.draftPlan) {
    const maxTitle = leftInner - 8;
    const t = status.draftPlan.title;
    const title = t.length > maxTitle ? t.slice(0, maxTitle - 1) + '…' : t;
    planLine = `${c.dim}v${status.draftPlan.version}  "${title}"  draft${c.reset}`;
  } else {
    planLine = `${c.dim}(no plan yet)${c.reset}`;
  }

  const tk = status.tasks;
  const bar = progressBar(tk.done, tk.total);
  const inProgStr =
    tk.inProgress > 0 ? `  ${c.blue}${tk.inProgress}▶${c.reset}` : `  ${c.dim}0▶${c.reset}`;
  const driftStr =
    status.driftAlerts.length > 0
      ? `  ${c.yellow}⚠ ${status.driftAlerts.length} drift${c.reset}`
      : `  ${c.green}✓ no drift${c.reset}`;

  // Labels aligned to 7 chars — same visual width as Claude Code's info rows
  const lbl = (s: string) => `${c.gray}${s.padEnd(7)}${c.reset}`;

  const leftRows: string[] = [
    `  ${c.bold}${c.cyan}PlanSync Terminal${c.reset}`,
    `  ${c.dim}${user}${c.reset}`,
    ``,
    `  ${lbl('Project')}${c.bold}${status.projectName}${c.reset}`,
    `  ${lbl('Plan')}${planLine}`,
    `  ${lbl('Phase')}${phaseIndicator(status.phase)}`,
    `  ${lbl('Tasks')}${bar}  ${c.dim}${tk.done}/${tk.total}${c.reset}${inProgStr}${driftStr}`,
    ``,
    `  ${c.yellow}▸${c.reset}  ${truncateAnsi(nextStep(status), leftInner - 3)}`,
  ];

  // ── Right column rows ──────────────────────────────────────────────────────
  const acts = recentActivity.slice(-4).reverse();
  const actRows: string[] = acts.length
    ? acts.map((a) => {
        const icon = a.urgent ? `${c.red}⚠${c.reset}` : `${c.yellow}◆${c.reset}`;
        const mins = Math.floor((Date.now() - a.ts) / 60_000);
        const age = mins === 0 ? 'now' : `${mins}m`;
        const prefixVis = 4; // "  x  "
        const maxText = rightInner - prefixVis - age.length - 1;
        const txt = a.text.length > maxText ? a.text.slice(0, maxText - 1) + '…' : a.text;
        const spaces = Math.max(1, rightInner - prefixVis - txt.length - age.length);
        return `  ${icon}  ${txt}${' '.repeat(spaces)}${c.dim}${age}${c.reset}`;
      })
    : [`  ${c.dim}No recent activity${c.reset}`];

  const divider = `  ${c.dim}${'─'.repeat(rightInner - 2)}${c.reset}`;

  const rightRows: string[] = [
    `  ${c.bold}Quick Tips${c.reset}`,
    ``,
    `  ${c.dim}Chat with AI naturally${c.reset}`,
    `  ${c.dim}! for shell commands${c.reset}`,
    `  ${c.dim}Tab to autocomplete /cmds${c.reset}`,
    divider,
    `  ${c.bold}Recent Activity${c.reset}`,
    ``,
    ...actRows,
  ];

  // ── Render two-column box ──────────────────────────────────────────────────
  const height = Math.max(leftRows.length, rightRows.length);
  const lw = leftInner + 2; // inner + one space each side
  const rw = rightInner + 2;

  console.log('');
  console.log(`  ${c.dim}╭${'─'.repeat(lw)}╮  ╭${'─'.repeat(rw)}╮${c.reset}`);
  for (let i = 0; i < height; i++) {
    const l = padTo(leftRows[i] ?? '', lw);
    const r = padTo(rightRows[i] ?? '', rw);
    console.log(`  ${c.dim}│${c.reset}${l}${c.dim}│  │${c.reset}${r}${c.dim}│${c.reset}`);
  }
  console.log(`  ${c.dim}╰${'─'.repeat(lw)}╯  ╰${'─'.repeat(rw)}╯${c.reset}`);
  console.log('');
  console.log(`  ${c.dim}Chat with PlanSync AI.  /help for all commands${c.reset}`);
  console.log('');
}

// ─── Task list ────────────────────────────────────────────────────────────────

const STATUS_ICON: Record<string, string> = {
  done: `${c.green}✓${c.reset}`,
  in_progress: `${c.blue}▶${c.reset}`,
  todo: '○',
  blocked: `${c.red}✗${c.reset}`,
};

export function printTasks(status: ProjectStatus) {
  if (status.taskList.length === 0) {
    console.log(`\n  ${c.dim}No tasks.${c.reset}\n`);
    return;
  }
  const t = status.tasks;
  console.log(
    `\n  ${c.bold}Tasks — ${status.projectName}${c.reset}  ${progressBar(t.done, t.total)}  ${c.dim}${t.done}/${t.total} done${c.reset}\n`,
  );
  const groups: Record<string, typeof status.taskList> = {
    in_progress: [],
    todo: [],
    blocked: [],
    done: [],
  };
  for (const t of status.taskList) (groups[t.status] ??= []).push(t);

  const showGroup = (label: string, items: typeof status.taskList) => {
    if (!items.length) return;
    console.log(`  ${c.gray}── ${label} (${items.length}) ──${c.reset}`);
    items.forEach((t) => {
      const prio =
        t.priority === 'p0'
          ? `${c.red}P0${c.reset}`
          : t.priority === 'p1'
            ? `${c.yellow}P1${c.reset}`
            : `${c.dim}P2${c.reset}`;
      const who = t.assignee ? `  ${c.dim}@${t.assignee}${c.reset}` : '';
      const title = t.title.length > 52 ? t.title.slice(0, 51) + '…' : t.title;
      console.log(`    ${STATUS_ICON[t.status] || '·'} ${title}  ${prio}${who}`);
    });
    console.log('');
  };

  showGroup('In Progress', groups.in_progress);
  showGroup('Todo', groups.todo);
  showGroup('Blocked', groups.blocked);
  showGroup('Done', groups.done);
}

// ─── Help ─────────────────────────────────────────────────────────────────────

export function printHelp(toolCount: number) {
  console.log('');
  console.log(`${c.bold}PlanSync Terminal — Commands${c.reset}`);
  console.log('');
  console.log(`  ${c.cyan}/status${c.reset}              Refresh project status`);
  console.log(`  ${c.cyan}/tasks${c.reset}               Show task list`);
  console.log(`  ${c.cyan}/project [id]${c.reset}        Switch project (interactive if no arg)`);
  console.log(`  ${c.cyan}/resume${c.reset}              Restore a previous session`);
  console.log(`  ${c.cyan}/clear${c.reset}               Clear conversation history`);
  console.log(`  ${c.cyan}/exec <taskId>${c.reset}       Execute a task in Genie`);
  console.log(
    `  ${c.cyan}/worker [agentName] [s]${c.reset}  Run agent task loop (e.g. /worker ai, /worker ai 30)`,
  );
  console.log(`  ${c.cyan}/code${c.reset}                Open Genie coding mode`);
  console.log(
    `  ${c.cyan}/explain rule <id>${c.reset}   Explain a verification rule (R-184 hard gate)`,
  );
  console.log(`  ${c.cyan}/notifs${c.reset}              View recent notifications (last 10 min)`);
  console.log(
    `  ${c.cyan}/verbose${c.reset}             Toggle verbose tool output (default: off)`,
  );
  console.log(`  ${c.cyan}/tools${c.reset}               List MCP tools`);
  console.log(`  ${c.cyan}/help${c.reset}                Show this help`);
  console.log(`  ${c.cyan}/quit${c.reset}                Exit`);
  console.log('');
  console.log(`  ${c.dim}! prefix runs shell commands, e.g.: !git log --oneline -5${c.reset}`);
  console.log('');
  console.log(`  ${c.bold}AI uses ${toolCount} MCP tools:${c.reset}`);
  console.log(
    `  ${c.dim}Create/update tasks, view plans, resolve drift, register executions, view team status…${c.reset}`,
  );
  console.log(`  ${c.dim}Just say it in natural language — AI picks the right tool.${c.reset}`);
  console.log('');
}

// ─── Notification printer (readline-aware) ────────────────────────────────────

export function makeNotifyPrinter(rl: readline.Interface, isPaused: () => boolean) {
  return (text: string) => {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    process.stdout.write(`${c.yellow}[PlanSync] ${text}${c.reset}\n`);
    if (!isPaused()) rl.prompt(true);
  };
}
