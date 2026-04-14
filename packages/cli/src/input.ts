/**
 * RawInput — raw mode terminal input handler for PlanSync Terminal.
 *
 * Replaces readline to enable:
 * - Real-time slash command suggestions (Claude Code style)
 * - Proper MCP notification display without corrupting input
 * - Clean pause/resume around subprocess spawns (Genie, etc.)
 *
 * Architecture:
 *   process.stdin (raw mode) → keypress events → RawInput.handleKey()
 *     → updates buffer/cursor → renders prompt + suggestions
 *     → resolves nextLine() promise when Enter is pressed
 */

import * as readline from 'readline';
import { c } from './ui.js';
import { appendInputHistory } from './session.js';

// ─── Unicode display width ────────────────────────────────────────────────────

/** Returns the terminal display width of a single character. */
function charWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  // CJK Unified Ideographs, Hangul, fullwidth, etc. → width 2
  if (
    cp > 0x2e7f &&
    ((cp >= 0x2e80 && cp <= 0x303f) || // CJK Radicals
      (cp >= 0x3040 && cp <= 0x33ff) || // Hiragana/Katakana/CJK misc
      (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Extension A
      (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
      (cp >= 0xac00 && cp <= 0xd7af) || // Hangul Syllables
      (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
      (cp >= 0xff01 && cp <= 0xff60) || // Fullwidth Forms
      (cp >= 0x1f000 && cp <= 0x1ffff)) // Emoji / Misc Symbols
  )
    return 2;
  return 1;
}

/** Returns display width of a string. */
function strWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch);
  return w;
}

// ─── Slash command type ───────────────────────────────────────────────────────

export interface SlashCmd {
  cmd: string;
  desc: string;
}

// ─── RawInput ─────────────────────────────────────────────────────────────────

export class RawInput {
  private buffer: string[] = [];
  private cursor = 0;
  private inputHistory: string[] = [];
  private histIdx = -1;
  private histSavedLine = '';
  private promptStr = '❯ ';
  private cmds: SlashCmd[];
  private suggestions: SlashCmd[] = [];
  private selIdx = -1; // -1 = no selection
  private suggestionLines = 0; // how many lines are currently rendered below prompt
  private active = false;
  private fallbackMode = false;
  private paused = false;
  private resolve: ((s: string | null) => void) | null = null;

  // Bracketed paste state — markers arrive as separate keypress events in raw mode
  private inPaste = false;
  private pasteChars: string[] = [];

  // External hooks
  onSigint: (() => void) | null = null; // called on Ctrl+C when not cancelling AI
  onCancel: (() => void) | null = null; // called on Ctrl+C when AI is in flight

  constructor(cmds: SlashCmd[]) {
    this.cmds = cmds;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  start(inputHistory: string[]): void {
    this.inputHistory = [...inputHistory];

    if (!process.stdin.isTTY) {
      this.fallbackMode = true;
      readline.emitKeypressEvents(process.stdin);
      return;
    }

    // Terminal safety: always restore on exit
    const restore = () => {
      if (process.stdin.isTTY && (process.stdin as NodeJS.ReadStream).isTTY) {
        try {
          process.stdin.setRawMode(false);
        } catch {
          /* ignore */
        }
      }
      process.stdout.write('\x1b[?2004l\r\n'); // disable bracketed paste
    };
    process.on('exit', restore);
    process.on('uncaughtException', (err) => {
      restore();
      process.stderr.write(err.stack || String(err));
      process.exit(1);
    });

    process.stdout.write('\x1b[?2004h'); // enable bracketed paste
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    process.stdin.on('keypress', this.handleKey.bind(this));
    process.on('SIGWINCH', () => {
      if (!this.paused) this.render();
    });

    this.active = true;
  }

  stop(): void {
    this.active = false;
    if (this.fallbackMode) return;
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch {
        /* ignore */
      }
    }
    process.stdout.write('\x1b[?2004l');
  }

  /** Call before spawning a subprocess with stdio:'inherit'. */
  pause(): void {
    this.paused = true;
    if (this.fallbackMode) return;
    this.clearDisplay();
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch {
        /* ignore */
      }
    }
    // CRITICAL: pause the stream so the parent process stops competing with
    // the child for fd 0 data. Without this, our process steals keystrokes
    // from the child (e.g. Genie), corrupting the keypress decoder state.
    process.stdin.pause();
  }

  /** Call after subprocess exits to restore raw mode and re-render prompt. */
  resume(): void {
    if (this.fallbackMode) {
      this.paused = false;
      return;
    }

    // Re-enable terminal settings
    process.stdin.resume();
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(true);
      } catch {
        /* ignore */
      }
    }
    process.stdout.write('\x1b[?2004h'); // re-enable bracketed paste

    // Keep paused=true through one event-loop tick so that any terminal
    // response sequences buffered while stdin was paused (e.g. Genie's
    // keyboard-mode restore reply arriving on stdin) are fired as keypress
    // events but discarded by handleKey (paused check). After the tick,
    // we flip paused=false and render the clean prompt.
    setImmediate(() => {
      this.paused = false;
      this.render();
    });
  }

  setPrompt(p: string): void {
    // Leading newlines are visual spacing — output them once here, don't bake
    // them into promptStr, or render() would re-emit them on every keypress,
    // accumulating blank lines with each character typed.
    const leading = p.match(/^(\n+)/)?.[1] ?? '';
    this.promptStr = p.slice(leading.length);
    if (!this.paused) {
      if (leading) process.stdout.write(leading);
      this.render();
    }
  }

  /**
   * Print a message above the current input line without corrupting it.
   * Used for MCP notifications.
   */
  printAbove(text: string): void {
    if (this.paused) {
      process.stdout.write(text + '\n');
      return;
    }
    this.clearDisplay();
    process.stdout.write(text + '\n');
    this.render();
  }

  /**
   * Wait for the user to type a line and press Enter.
   * Returns null on EOF (Ctrl+D).
   */
  nextLine(): Promise<string | null> {
    if (this.fallbackMode) {
      return this.fallbackReadLine();
    }
    this.buffer = [];
    this.cursor = 0;
    this.histIdx = -1;
    this.histSavedLine = '';
    this.suggestions = [];
    this.selIdx = -1;
    this.suggestionLines = 0;
    if (!this.paused) this.render(); // do not render while a subprocess has the terminal
    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  // ─── Fallback (non-TTY) ──────────────────────────────────────────────────

  private fallbackReadLine(): Promise<string | null> {
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(this.promptStr, (answer) => {
        rl.close();
        resolve(answer);
      });
      rl.on('close', () => resolve(null));
    });
  }

  // ─── Key handler ────────────────────────────────────────────────────────────

  private handleKey(
    ch: string | undefined,
    key: { name?: string; ctrl?: boolean; meta?: boolean; sequence?: string } | undefined,
  ): void {
    if (this.paused) return;

    const seq = key?.sequence ?? ch ?? '';

    // ── Bracketed paste markers — arrive as separate events in raw mode ───────
    if (seq === '\x1b[200~') {
      this.inPaste = true;
      this.pasteChars = [];
      return;
    }
    if (seq === '\x1b[201~') {
      this.inPaste = false;
      if (this.resolve) this.handlePaste(this.pasteChars.join(''));
      this.pasteChars = [];
      return;
    }
    if (this.inPaste) {
      // Accumulate paste content (newlines arrive as '\r' or '\n')
      this.pasteChars.push(ch === '\r' ? '\n' : ch || '');
      return;
    }

    // ── Ctrl+C and Ctrl+D are handled even when not waiting for input ─────────
    // This allows cancelling in-flight AI requests (this.resolve is null during AI)
    if (key?.ctrl && key.name === 'c') {
      this.handleCtrlC();
      return;
    }
    if (key?.ctrl && key.name === 'd') {
      if (!this.resolve) return;
      this.handleEof();
      return;
    }

    // All other keys require an active nextLine() call
    if (!this.resolve) return;

    // ── Special keys ─────────────────────────────────────────────────────────
    if (key?.ctrl) {
      switch (key.name) {
        case 'c':
          this.handleCtrlC();
          return; // already handled above, kept for clarity
        case 'd':
          this.handleEof();
          return;
        case 'a':
          this.moveCursorTo(0);
          return;
        case 'e':
          this.moveCursorTo(this.buffer.length);
          return;
        case 'k':
          this.buffer = this.buffer.slice(0, this.cursor);
          this.onChange();
          return;
        case 'u':
          this.buffer = this.buffer.slice(this.cursor);
          this.cursor = 0;
          this.onChange();
          return;
        case 'w':
          this.deleteWordBack();
          return;
        case 'l':
          process.stdout.write('\x1b[2J\x1b[H');
          this.render();
          return;
      }
      return;
    }

    switch (key?.name) {
      case 'return':
      case 'enter':
        this.handleEnter();
        return;
      case 'backspace':
        this.handleBackspace();
        return;
      case 'delete':
        if (this.cursor < this.buffer.length) {
          this.buffer.splice(this.cursor, 1);
          this.onChange();
        }
        return;
      case 'left':
        if (this.cursor > 0) {
          this.cursor--;
          this.render();
        }
        return;
      case 'right':
        if (this.cursor < this.buffer.length) {
          this.cursor++;
          this.render();
        }
        return;
      case 'up':
        if (this.suggestions.length > 0) {
          this.selIdx = this.selIdx <= 0 ? this.suggestions.length - 1 : this.selIdx - 1;
          this.render();
        } else {
          this.historyUp();
        }
        return;
      case 'down':
        if (this.suggestions.length > 0) {
          this.selIdx = this.selIdx >= this.suggestions.length - 1 ? -1 : this.selIdx + 1;
          this.render();
        } else {
          this.historyDown();
        }
        return;
      case 'home':
        this.moveCursorTo(0);
        return;
      case 'end':
        this.moveCursorTo(this.buffer.length);
        return;
      case 'escape':
        if (this.suggestions.length > 0) {
          this.suggestions = [];
          this.selIdx = -1;
          this.render();
        } else {
          this.buffer = [];
          this.cursor = 0;
          this.onChange();
        }
        return;
      case 'tab':
        this.handleTab();
        return;
    }

    // ── Regular character ────────────────────────────────────────────────────
    if (ch && ch.length > 0 && !key?.ctrl && !key?.meta) {
      // Insert char(s) at cursor — handle multi-char sequences (emoji, etc.)
      for (const c of ch) {
        if (c.charCodeAt(0) >= 32) {
          // printable
          this.buffer.splice(this.cursor, 0, c);
          this.cursor++;
        }
      }
      this.onChange();
    }
  }

  // ─── Enter ───────────────────────────────────────────────────────────────

  private handleEnter(): void {
    // If a suggestion is selected, complete it instead of submitting
    if (this.selIdx >= 0 && this.suggestions.length > 0) {
      const chosen = this.suggestions[this.selIdx].cmd;
      this.buffer = [...chosen];
      this.cursor = this.buffer.length;
      this.selIdx = -1;
      this.suggestions = [];
      this.render();
      return;
    }

    const input = this.buffer.join('');
    // Keep the submitted text on screen (don't wipe it with clearDisplay).
    // Go to col 0, re-write prompt+input, clear suggestions below, then newline.
    process.stdout.write('\r');
    process.stdout.write(this.promptStr + input);
    process.stdout.write('\x1b[J'); // clear only what's below (suggestions, if any)
    process.stdout.write('\n');
    this.suggestionLines = 0;

    // Reset buffer so the next render() call (from setPrompt) shows a clean prompt
    this.buffer = [];
    this.cursor = 0;
    this.suggestions = [];
    this.selIdx = -1;
    this.suggestionLines = 0;

    // History dedup
    if (input.trim() && input !== this.inputHistory[0]) {
      this.inputHistory.unshift(input);
      appendInputHistory(input);
    }

    const resolve = this.resolve!;
    this.resolve = null;
    resolve(input);
  }

  // ─── Ctrl+C ──────────────────────────────────────────────────────────────

  private ctrlCCount = 0;
  private ctrlCTimer: ReturnType<typeof setTimeout> | null = null;

  private handleCtrlC(): void {
    if (this.buffer.length > 0 || this.suggestions.length > 0) {
      // Cancel current input — clear and re-render prompt on the SAME line (no \n)
      this.suggestions = [];
      this.selIdx = -1;
      this.buffer = [];
      this.cursor = 0;
      this.clearDisplay();
      this.render();
      return;
    }

    this.ctrlCCount++;
    if (this.ctrlCTimer) clearTimeout(this.ctrlCTimer);
    if (this.ctrlCCount === 1) {
      this.printAbove(`${c.dim}(Press Ctrl+C again to exit)${c.reset}`);
      this.ctrlCTimer = setTimeout(() => {
        this.ctrlCCount = 0;
      }, 2000);
    } else {
      if (this.onSigint) this.onSigint();
    }
  }

  // ─── EOF ─────────────────────────────────────────────────────────────────

  private handleEof(): void {
    if (this.buffer.length > 0) return; // Ctrl+D with content = ignore
    this.clearDisplay();
    process.stdout.write('\n');
    const resolve = this.resolve!;
    this.resolve = null;
    resolve(null);
  }

  // ─── Backspace ───────────────────────────────────────────────────────────

  private handleBackspace(): void {
    if (this.cursor === 0) return;
    this.buffer.splice(this.cursor - 1, 1);
    this.cursor--;
    this.onChange();
  }

  // ─── Word delete ─────────────────────────────────────────────────────────

  private deleteWordBack(): void {
    let i = this.cursor;
    while (i > 0 && this.buffer[i - 1] === ' ') i--;
    while (i > 0 && this.buffer[i - 1] !== ' ') i--;
    this.buffer.splice(i, this.cursor - i);
    this.cursor = i;
    this.onChange();
  }

  // ─── Tab ─────────────────────────────────────────────────────────────────

  private handleTab(): void {
    const line = this.buffer.join('');
    if (!line.startsWith('/')) return;

    const matches = this.cmds.filter((c) => c.cmd.startsWith(line));
    if (matches.length === 1) {
      // Single match: auto-complete
      this.buffer = [...matches[0].cmd];
      this.cursor = this.buffer.length;
      this.suggestions = [];
      this.selIdx = -1;
      this.render();
    } else if (matches.length > 1) {
      // Multiple matches: show suggestions
      this.suggestions = matches;
      this.selIdx = -1;
      this.render();
    }
  }

  // ─── Paste handling ──────────────────────────────────────────────────────

  private handlePaste(content: string): void {
    // content has already had markers stripped; newlines are '\n'

    const lines = content.split('\n');
    if (lines.length <= 1) {
      // Single line paste — treat as normal input
      for (const ch of content) {
        if (ch.charCodeAt(0) >= 32) {
          this.buffer.splice(this.cursor, 0, ch);
          this.cursor++;
        }
      }
      this.onChange();
      return;
    }

    // Multi-line paste — show summary and submit combined content
    const trimmed = content.trim();
    const lineCount = lines.length;
    const charCount = trimmed.length;

    this.clearDisplay();
    if (lineCount > 2) {
      process.stdout.write(
        `${c.dim}⎘ Pasted ${lineCount} lines (${charCount} chars) — sending to AI${c.reset}\n`,
      );
    } else {
      process.stdout.write('\n');
    }

    if (trimmed && this.resolve) {
      const resolve = this.resolve;
      this.resolve = null;
      resolve(trimmed);
    }
  }

  // ─── History navigation ──────────────────────────────────────────────────

  private historyUp(): void {
    if (this.inputHistory.length === 0) return;
    if (this.histIdx === -1) {
      this.histSavedLine = this.buffer.join('');
    }
    if (this.histIdx < this.inputHistory.length - 1) {
      this.histIdx++;
      this.buffer = [...this.inputHistory[this.histIdx]];
      this.cursor = this.buffer.length;
      this.onChange();
    }
  }

  private historyDown(): void {
    if (this.histIdx === -1) return;
    this.histIdx--;
    if (this.histIdx === -1) {
      this.buffer = [...this.histSavedLine];
    } else {
      this.buffer = [...this.inputHistory[this.histIdx]];
    }
    this.cursor = this.buffer.length;
    this.onChange();
  }

  // ─── Cursor movement ─────────────────────────────────────────────────────

  private moveCursorTo(pos: number): void {
    this.cursor = Math.max(0, Math.min(pos, this.buffer.length));
    this.render();
  }

  // ─── onChange: update suggestions and re-render ───────────────────────────

  private onChange(): void {
    const line = this.buffer.join('');
    if (line.startsWith('/') && line.length > 0) {
      this.suggestions = this.cmds.filter((c) => c.cmd.startsWith(line));
      // Don't reset selIdx if it's still valid
      if (this.selIdx >= this.suggestions.length) this.selIdx = -1;
    } else {
      this.suggestions = [];
      this.selIdx = -1;
    }
    this.render();
  }

  // ─── Rendering ───────────────────────────────────────────────────────────

  private render(): void {
    const promptVisible = this.stripAnsi(this.promptStr);
    const bufStr = this.buffer.join('');
    const newSuggLines = this.suggestions.length;

    // Cursor is already at the prompt line (render always ends with cursor-up back here).
    // Just go to column 0 and clear to end of screen — this erases old suggestions too.
    process.stdout.write('\r\x1b[J');

    // Write prompt + buffer
    process.stdout.write(this.promptStr + bufStr);

    // Write suggestions
    if (newSuggLines > 0) {
      process.stdout.write('\n');
      for (let i = 0; i < this.suggestions.length; i++) {
        const { cmd, desc } = this.suggestions[i];
        const isSelected = i === this.selIdx;
        const prefix = isSelected ? `${c.bold}▶${c.reset} ` : '  ';
        const cmdPart = isSelected
          ? `\x1b[7m${cmd.padEnd(12)}\x1b[27m` // reverse video for selection
          : `${c.cyan}${cmd.padEnd(12)}${c.reset}`;
        const descPart = `${c.dim}${desc}${c.reset}`;
        process.stdout.write(`${prefix}${cmdPart} ${descPart}\n`);
      }
      // Move cursor back up to prompt line
      process.stdout.write(`\x1b[${newSuggLines + 1}A\r`);
    }

    this.suggestionLines = newSuggLines;

    // Position cursor correctly on the prompt line
    const promptWidth = strWidth(promptVisible);
    const cursorWidth = strWidth(this.buffer.slice(0, this.cursor).join(''));
    const totalCol = promptWidth + cursorWidth;
    process.stdout.write(`\x1b[${totalCol + 1}G`); // move to column (1-based)
  }

  /** Clear the input area (prompt + suggestions). */
  clearDisplay(): void {
    // Cursor is at the prompt line — \r\x1b[J clears it and everything below (suggestions).
    process.stdout.write('\r\x1b[J');
    this.suggestionLines = 0;
  }

  /** Strip ANSI escape codes to compute visible string width. */
  private stripAnsi(s: string): string {
    // eslint-disable-next-line no-control-regex
    return s.replace(/\x1b\[[0-9;]*[mGKJABCDHs]/g, '');
  }
}
