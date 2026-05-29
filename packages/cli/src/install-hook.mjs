#!/usr/bin/env node
/**
 * R-206 L2: install (or remove) the PreToolUse hook that wires
 * `plansync abort-check` into every Claude Code tool call.
 *
 * Default location is `<cwd>/.claude/settings.json` — the project-level
 * settings file that Claude Code reads for ALL team members, NOT the
 * gitignored `settings.local.json` and NOT `~/.claude/settings.json`.
 * Rationale: a teammate who clones the repo and opens it in Claude Code
 * should automatically inherit the drift hard-interrupt guard, without
 * each person running an install command on their own machine. The user
 * is expected to `git add .claude/settings.json && git commit` after the
 * first install.
 *
 * `--user` writes to `~/.claude/settings.json` instead, for the personal
 * "enable on every project I open" case. Always either project OR user;
 * never both at once.
 *
 * `--ide` is currently only `claude` (the default). Cursor / Codex /
 * Continue / Cline do not yet expose a comparable pre-tool hook; we
 * refuse with a clear explanation rather than write a fake adapter
 * that the user might believe is enforcing something it isn't.
 *
 * Idempotent — running install repeatedly leaves the settings file with
 * exactly one copy of the hook entry. `--uninstall` removes only the
 * PlanSync hook command from the PreToolUse array; other hooks are
 * preserved.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';

const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

// Resolve the absolute path to `bin/plansync` so the hook command works
// regardless of the user's PATH or the IDE's cwd. The script lives at
// `<repo>/packages/cli/src/install-hook.mjs`; bin/plansync is at
// `<repo>/bin/plansync` — three levels up from src/.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLANSYNC_BIN = path.resolve(__dirname, '..', '..', '..', 'bin', 'plansync');

const HOOK_COMMAND = `${PLANSYNC_BIN} abort-check`;
const HOOK_MATCHER = '.*';

/**
 * Recognise a previously-installed PlanSync abort-check hook even when the
 * `bin/plansync` path differs (different clone, repo moved, the dogfood
 * `bin/plansync abort-check` relative form, or the plain `plansync
 * abort-check` PATH form). Used by both the idempotent install check
 * and the uninstall filter.
 */
function isPlanSyncAbortCheckCommand(cmd) {
  if (typeof cmd !== 'string') return false;
  // Match any of: `plansync abort-check`, `bin/plansync abort-check`,
  // `/abs/path/bin/plansync abort-check`. The space-separated " abort-check"
  // suffix avoids matching unrelated commands that happen to end with the
  // literal `plansync`.
  return /(^|\/)plansync\s+abort-check(\s|$)/.test(cmd);
}
const SUPPORTED_IDES = new Set(['claude']);
const UNSUPPORTED_IDES = new Set(['cursor', 'codex', 'continue', 'cline']);

function die(msg, code = 1) {
  process.stderr.write(`${RED}✗ ${msg}${RESET}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const args = { ide: 'claude', scope: 'project', uninstall: false };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--user') {
      args.scope = 'user';
      i += 1;
    } else if (a === '--uninstall') {
      args.uninstall = true;
      i += 1;
    } else if (a === '--ide') {
      args.ide = (argv[i + 1] || '').toLowerCase();
      i += 2;
    } else if (a.startsWith('--ide=')) {
      args.ide = a.slice('--ide='.length).toLowerCase();
      i += 1;
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else {
      die(`unknown argument: ${a}`);
    }
  }
  return args;
}

function printHelp() {
  process.stdout.write(`Usage: plansync install-hook [OPTIONS]

  Install (or remove) the Claude Code PreToolUse hook that converts a
  PlanSync drift into a hard mid-execution interrupt.

Options:
  --user                Write to ~/.claude/settings.json (personal, NOT team-shared)
                        instead of the default project-level location.
  --ide=<name>          Target IDE. Currently only "claude" is supported;
                        Cursor / Codex / Continue / Cline have no comparable
                        pre-tool hook mechanism.
  --uninstall           Remove the PlanSync hook entry. Other hooks are preserved.
  --help                Show this help.

Default location is <cwd>/.claude/settings.json — please git-commit it after
install so all teammates inherit the guard.
`);
}

function resolveSettingsPath(scope) {
  if (scope === 'user') {
    return path.join(os.homedir(), '.claude', 'settings.json');
  }
  return path.join(process.cwd(), '.claude', 'settings.json');
}

function readSettings(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, 'utf8');
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      die(`${filePath} does not contain a JSON object at the top level`);
    }
    return parsed;
  } catch (err) {
    die(`failed to parse ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function writeSettings(filePath, settings) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // 4-space indent to match Claude Code's own convention; trailing
  // newline so editors / git don't fight us.
  fs.writeFileSync(filePath, `${JSON.stringify(settings, null, 4)}\n`, 'utf8');
}

/**
 * Insert the PlanSync hook into the settings object if it's not already
 * present. Returns `true` if the file was modified, `false` if a no-op.
 *
 * Shape we write (Claude Code PreToolUse format):
 *   {
 *     "hooks": {
 *       "PreToolUse": [
 *         { "matcher": ".*", "hooks": [{ "type": "command", "command": "plansync abort-check" }] },
 *         ...other entries preserved...
 *       ]
 *     }
 *   }
 */
function installHook(settings) {
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
  const pre = Array.isArray(settings.hooks.PreToolUse) ? settings.hooks.PreToolUse : [];
  // Idempotent check: is there already an entry whose inner hooks list
  // includes our command? Match on the command string, not on the entire
  // entry, so a user who customised the matcher (e.g. restricted it to
  // mcp__plansync__*) still gets recognised as "already installed".
  const already = pre.some(
    (entry) =>
      entry &&
      Array.isArray(entry.hooks) &&
      entry.hooks.some(
        (h) =>
          h && typeof h === 'object' && h.type === 'command' && isPlanSyncAbortCheckCommand(h.command),
      ),
  );
  if (already) {
    settings.hooks.PreToolUse = pre;
    return false;
  }
  pre.push({
    matcher: HOOK_MATCHER,
    hooks: [{ type: 'command', command: HOOK_COMMAND }],
  });
  settings.hooks.PreToolUse = pre;
  return true;
}

/**
 * Remove only the PlanSync hook command. Other entries (other matchers,
 * other commands in the same entry) are preserved. Returns `true` if the
 * file was modified.
 */
function uninstallHook(settings) {
  if (!settings.hooks || !Array.isArray(settings.hooks.PreToolUse)) return false;
  const pre = settings.hooks.PreToolUse;
  let changed = false;
  const next = [];
  for (const entry of pre) {
    if (!entry || !Array.isArray(entry.hooks)) {
      next.push(entry);
      continue;
    }
    const filteredHooks = entry.hooks.filter(
      (h) =>
        !(
          h &&
          typeof h === 'object' &&
          h.type === 'command' &&
          isPlanSyncAbortCheckCommand(h.command)
        ),
    );
    if (filteredHooks.length !== entry.hooks.length) changed = true;
    if (filteredHooks.length > 0) {
      next.push({ ...entry, hooks: filteredHooks });
    } else {
      // Entry had only our hook; drop the whole entry rather than leave
      // a `hooks: []` stub that Claude Code would skip anyway.
      changed = true;
    }
  }
  settings.hooks.PreToolUse = next;
  return changed;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (UNSUPPORTED_IDES.has(args.ide)) {
    process.stderr.write(
      `${YELLOW}Hook-based hard interrupt is currently only supported in Claude Code.${RESET}\n` +
        `${DIM}${args.ide} does not yet expose a pre-tool-call hook mechanism. Your session\n` +
        `still has L1 protection: every PlanSync tool call returns RUN_ABORTED after\n` +
        `drift, and complete is hard-rejected.${RESET}\n`,
    );
    process.exit(1);
  }
  if (!SUPPORTED_IDES.has(args.ide)) {
    die(`unknown --ide value: ${args.ide} (supported: claude)`);
  }

  const settingsPath = resolveSettingsPath(args.scope);
  const settings = readSettings(settingsPath);

  let changed;
  if (args.uninstall) {
    changed = uninstallHook(settings);
  } else {
    changed = installHook(settings);
  }

  if (!changed) {
    process.stdout.write(
      `${DIM}plansync install-hook: no change (${args.uninstall ? 'hook not present' : 'hook already installed'} at ${settingsPath})${RESET}\n`,
    );
    process.exit(0);
  }

  writeSettings(settingsPath, settings);

  if (args.uninstall) {
    process.stdout.write(
      `${GREEN}✓${RESET} Removed PlanSync PreToolUse hook from ${settingsPath}\n` +
        `${DIM}  Restart Claude Code for the change to take effect.${RESET}\n`,
    );
    return;
  }

  if (args.scope === 'project') {
    process.stdout.write(
      `${GREEN}✓${RESET} Installed PlanSync PreToolUse hook in ${settingsPath}\n` +
        `${DIM}  This file is project-level — please commit it so the whole team gets\n` +
        `  the same drift hard-interrupt protection:${RESET}\n` +
        `    git add .claude/settings.json\n` +
        `    git commit -m "chore: enable plansync abort-check hook"\n` +
        `${DIM}  Then restart Claude Code for the hook to take effect.${RESET}\n`,
    );
  } else {
    process.stdout.write(
      `${GREEN}✓${RESET} Installed PlanSync PreToolUse hook in ${settingsPath}\n` +
        `${DIM}  This file is per-user; it applies only to YOUR Claude Code sessions.\n` +
        `  To share the hook with teammates, run \`plansync install-hook\` (without\n` +
        `  --user) inside a project so the project-level settings.json gets committed.${RESET}\n` +
        `${DIM}  Restart Claude Code for the hook to take effect.${RESET}\n`,
    );
  }
}

try {
  main();
} catch (err) {
  die(err instanceof Error ? err.message : String(err));
}
