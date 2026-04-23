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

  // Wide terminal → big ASCII banner; narrow → compact box.
  if (termCols >= BANNER_WIDTH + 4) {
    const lp = Math.max(0, Math.floor((termCols - BANNER_WIDTH) / 2));
    const tagPad = Math.max(0, Math.floor((termCols - TAGLINE.length) / 2));
    process.stdout.write('\n');
    for (const line of BANNER_LINES) {
      process.stdout.write(`${' '.repeat(lp)}\x1b[35m\x1b[1m${line}\x1b[0m\n`);
    }
    process.stdout.write(`\n${' '.repeat(tagPad)}\x1b[2m${TAGLINE}\x1b[0m\n\n`);
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

export function printToolError(message: string, ms: number): void {
  const short = message.length > 120 ? message.slice(0, 117) + '…' : message;
  process.stdout.write(
    `  ${c.dim}╰─${c.reset} ${c.red}✘${c.reset} ${short}  ${c.dim}${ms}ms${c.reset}\n`,
  );
}

// ─── Project status types ─────────────────────────────────────────────────────

export interface ProjectStatus {
  projectId: string;
  projectName: string;
  activePlan: { version: number; title: string; goal: string } | null;
  proposedPlan: {
    version: number;
    title: string;
    reviews: { reviewer: string; status: string }[];
  } | null;
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
    activePlan: null,
    proposedPlan: null,
    tasks: { total: 0, done: 0, inProgress: 0, todo: 0, blocked: 0 },
    taskList: [],
    driftAlerts: [],
  };
}

// ─── Banner ───────────────────────────────────────────────────────────────────

const REVIEW_ICON: Record<string, string> = {
  approved: `${c.green}✓${c.reset}`,
  rejected: `${c.red}✗${c.reset}`,
  pending: `${c.dim}○${c.reset}`,
};

export function banner(status: ProjectStatus, toolCount: number, user: string) {
  const cols = process.stdout.columns || 70;
  const width = Math.min(cols - 2, 70);
  const title = 'PlanSync Terminal';
  const pad = Math.max(0, width - 2 - title.length);

  console.log('');
  console.log(`${c.blue}${c.bold}╔${'═'.repeat(width - 2)}╗${c.reset}`);
  console.log(
    `${c.blue}${c.bold}║${c.reset}${c.bold}${' '.repeat(Math.floor(pad / 2))}${title}${' '.repeat(Math.ceil(pad / 2))}${c.reset}${c.blue}${c.bold}║${c.reset}`,
  );
  console.log(`${c.blue}${c.bold}╚${'═'.repeat(width - 2)}╝${c.reset}`);
  console.log('');

  let planStr: string;
  if (status.activePlan) {
    planStr = `v${status.activePlan.version} "${status.activePlan.title}"`;
  } else if (status.proposedPlan) {
    const p = status.proposedPlan;
    const reviewStr =
      p.reviews.length > 0
        ? '  ' +
          p.reviews
            .map((r) => `${c.dim}${r.reviewer}${c.reset} ${REVIEW_ICON[r.status] ?? '○'}`)
            .join('  ')
        : `  ${c.dim}awaiting approval${c.reset}`;
    planStr = `${c.yellow}Pending Review${c.reset}  v${p.version} "${p.title}"${reviewStr}`;
  } else {
    planStr = `${c.dim}(no active plan)${c.reset}`;
  }

  const t = status.tasks;
  const driftStr =
    status.driftAlerts.length > 0
      ? `${c.yellow}⚠ ${status.driftAlerts.length}${c.reset}`
      : `${c.green}✓ none${c.reset}`;

  console.log(
    `  ${c.gray}User${c.reset}    ${c.bold}${user}${c.reset}   ${c.gray}Project${c.reset}  ${c.cyan}${status.projectName}${c.reset}`,
  );
  console.log(`  ${c.gray}Plan${c.reset}    ${planStr}`);
  if (status.activePlan?.goal) {
    const g = status.activePlan.goal.slice(0, Math.min(cols - 12, 80));
    console.log(`          ${c.dim}${g}${status.activePlan.goal.length > 80 ? '…' : ''}${c.reset}`);
  }
  console.log(
    `  ${c.gray}Tasks${c.reset}   ${t.total} · ${c.green}${t.done} done${c.reset} / ${c.blue}${t.inProgress} in progress${c.reset} / ${t.todo} todo / ${c.yellow}${t.blocked} blocked${c.reset}`,
  );
  console.log(`  ${c.gray}Drift${c.reset}   ${driftStr}`);
  if (status.driftAlerts.length > 0) {
    status.driftAlerts.forEach((d) => {
      let ownerTag: string;
      if (!d.assignee) {
        ownerTag = `  ${c.dim}(unassigned)${c.reset}`;
      } else if (d.assignee === user) {
        ownerTag = `  ${c.yellow}← yours to resolve${c.reset}`;
      } else {
        ownerTag = `  ${c.dim}→ @${d.assignee}${c.reset}`;
      }
      console.log(`          ${c.yellow}⚠${c.reset} [${d.severity}] "${d.taskTitle}"${ownerTag}`);
    });
  }
  console.log('');
  console.log(`  ${c.dim}Chat with PlanSync AI — it will call tools automatically.${c.reset}`);
  console.log(`  ${c.dim}! runs shell commands  /help for all commands${c.reset}`);
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
  console.log(
    `\n  ${c.bold}Tasks — ${status.projectName}${c.reset}  ${c.dim}(${status.taskList.length})${c.reset}\n`,
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
