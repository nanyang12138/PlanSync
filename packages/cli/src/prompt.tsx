/**
 * prompt.tsx — Ink-based interactive prompt for PlanSync Terminal.
 *
 * Persistent mode: the Ink instance stays mounted across turns.
 * Between turns, the input is disabled (shows "❯ …"). On the next
 * nextLine() call, a 'reset' event re-enables it.
 */

import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput, render, type Instance, type Key } from 'ink';
import { EventEmitter } from 'events';
import { createInterface } from 'readline';
import { appendInputHistory } from './session.js';
import { type SlashCmd } from './input.js';

export type { SlashCmd };

// ─── Bracketed paste handling (R-067) ─────────────────────────────────────────

/**
 * Escape sequences emitted by terminals when bracketed paste mode is enabled.
 * The terminal wraps any pasted text with these two markers so the
 * application can distinguish a paste from typed input.
 */
export const PASTE_START = '\x1b[200~';
export const PASTE_END = '\x1b[201~';

/** Enable bracketed paste mode on the host terminal. */
export const ENABLE_BRACKETED_PASTE = '\x1b[?2004h';
/** Disable bracketed paste mode on the host terminal. */
export const DISABLE_BRACKETED_PASTE = '\x1b[?2004l';

export interface PasteParseResult {
  /** Plain input that came before any paste-start marker. */
  before: string;
  /**
   * Complete pasted payload, present only when both the start and the end
   * marker arrived in this single chunk.
   */
  paste: string | null;
  /**
   * True when a paste-start marker was found but no matching end marker
   * appeared in the same chunk. The caller should switch to streaming mode
   * and feed subsequent chunks into {@link continueBracketedPaste}.
   */
  pasteStarted: boolean;
  /** Partial paste content (after the start marker) when `pasteStarted`. */
  pasteFragment: string;
  /** Plain input that came after the paste-end marker. */
  after: string;
}

/**
 * Parse an input chunk that may contain bracketed-paste markers.
 *
 * Three outcomes:
 *   - no start marker → all input is regular keystrokes (`before`)
 *   - start marker without end → paste opened mid-chunk; caller should
 *     buffer `pasteFragment` and continue parsing future chunks
 *   - start and end markers → a complete paste payload is in `paste`
 *
 * Pure helper so the state machine can be unit-tested without mounting Ink.
 */
export function parseBracketedPaste(input: string): PasteParseResult {
  const startIdx = input.indexOf(PASTE_START);
  if (startIdx === -1) {
    return {
      before: input,
      paste: null,
      pasteStarted: false,
      pasteFragment: '',
      after: '',
    };
  }
  const before = input.slice(0, startIdx);
  const rest = input.slice(startIdx + PASTE_START.length);
  const endIdx = rest.indexOf(PASTE_END);
  if (endIdx === -1) {
    return {
      before,
      paste: null,
      pasteStarted: true,
      pasteFragment: rest,
      after: '',
    };
  }
  return {
    before,
    paste: rest.slice(0, endIdx),
    pasteStarted: true,
    pasteFragment: '',
    after: rest.slice(endIdx + PASTE_END.length),
  };
}

export interface PasteContinueResult {
  /** Complete paste payload (buffer + chunk up to end marker) once closed. */
  paste: string | null;
  /** Remaining input after the paste-end marker (treat as regular keystrokes). */
  remainder: string;
  /** Updated paste buffer when the end marker has not yet arrived. */
  updatedBuffer: string;
}

/**
 * Continue parsing a paste-in-progress. Call this from subsequent useInput
 * chunks while a previous {@link parseBracketedPaste} call returned
 * `pasteStarted: true` without a `paste` payload.
 */
export function continueBracketedPaste(buffer: string, input: string): PasteContinueResult {
  const endIdx = input.indexOf(PASTE_END);
  if (endIdx === -1) {
    return { paste: null, remainder: '', updatedBuffer: buffer + input };
  }
  return {
    paste: buffer + input.slice(0, endIdx),
    remainder: input.slice(endIdx + PASTE_END.length),
    updatedBuffer: '',
  };
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Notif {
  text: string;
  ts: number;
  urgent?: boolean;
}

const NOTIF_TTL = 10 * 60 * 1000; // 10 minutes in ms

// ─── Terminal width tracking ──────────────────────────────────────────────────

/**
 * Returns the current terminal width in columns, defaulting to 80 when the
 * stream does not report a size (e.g. non-TTY).
 */
export function getTerminalColumns(stream: NodeJS.WriteStream = process.stdout): number {
  return stream.columns || 80;
}

/**
 * Subscribe `handler` to the host stream's `resize` event. Returns a teardown
 * function that removes the listener.
 *
 * Extracted as a standalone helper so the SIGWINCH plumbing for PromptUI can
 * be unit-tested without mounting Ink. PromptUI uses this inside a
 * `useEffect` to re-render its separators whenever the user resizes the
 * terminal window.
 */
export function subscribeToResize(
  handler: () => void,
  stream: NodeJS.WriteStream = process.stdout,
): () => void {
  stream.on('resize', handler);
  return () => {
    stream.off('resize', handler);
  };
}

// ─── PromptUI component ───────────────────────────────────────────────────────

interface PromptProps {
  promptStr: string;
  commands: SlashCmd[];
  history: string[];
  events: EventEmitter;
}

function PromptUI({ promptStr: initialPrompt, commands, history, events }: PromptProps) {
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);
  const [histIdx, setHistIdx] = useState(-1);
  const [histSaved, setHistSaved] = useState('');
  const [suggestions, setSuggestions] = useState<SlashCmd[]>([]);
  const [selIdx, setSelIdx] = useState(-1);
  const [urgentFlash, setUrgentFlash] = useState<string | null>(null);
  const [promptStr, setPromptStr] = useState(initialPrompt);
  const [disabled, setDisabled] = useState(false);
  const [lastSubmitted, setLastSubmitted] = useState('');
  const [columns, setColumns] = useState<number>(() => getTerminalColumns());

  // R-066: re-render separators when the user resizes the terminal window.
  // Without this, `process.stdout.columns` is captured only on initial render,
  // leaving the top/bottom separator lines stuck at the original width.
  useEffect(() => {
    const update = () => setColumns(getTerminalColumns());
    update();
    return subscribeToResize(update);
  }, []);

  // R-067: enable bracketed paste mode so the host terminal wraps pasted text
  // with \x1b[200~ … \x1b[201~. Without this, multi-line pastes are
  // interpreted as a series of individual keystrokes — newlines fire `Enter`
  // and submit each line separately.
  useEffect(() => {
    if (process.stdout.isTTY) {
      process.stdout.write(ENABLE_BRACKETED_PASTE);
    }
    return () => {
      if (process.stdout.isTTY) {
        process.stdout.write(DISABLE_BRACKETED_PASTE);
      }
    };
  }, []);

  // R-067: paste buffer used when a paste spans multiple useInput chunks.
  // Ref (not state) so consecutive chunks within the same tick see the latest
  // buffer without waiting for a re-render.
  const pasteBufferRef = useRef<string | null>(null);

  // Urgent-only flash: drift / stale / plan_activated / review events — auto-clears after 30s
  useEffect(() => {
    let clearTimer: ReturnType<typeof setTimeout> | null = null;
    const handler = (msg: string) => {
      if (clearTimer) clearTimeout(clearTimer);
      setUrgentFlash(msg);
      clearTimer = setTimeout(() => setUrgentFlash(null), 30000);
    };
    events.on('urgentFlash', handler);
    return () => {
      events.off('urgentFlash', handler);
      if (clearTimer) clearTimeout(clearTimer);
    };
  }, [events]);

  useEffect(() => {
    const handler = (p: string) => setPromptStr(p);
    events.on('setPrompt', handler);
    return () => {
      events.off('setPrompt', handler);
    };
  }, [events]);

  // 'reset' event: re-enable input for the next turn
  useEffect(() => {
    const handler = () => {
      setDisabled(false);
      setValue('');
      setCursor(0);
      setSuggestions([]);
      setSelIdx(-1);
      setHistIdx(-1);
      setHistSaved('');
      setLastSubmitted('');
    };
    events.on('reset', handler);
    return () => {
      events.off('reset', handler);
    };
  }, [events]);

  const calcSuggestions = (val: string): SlashCmd[] => {
    if (val.startsWith('/') && val.length >= 1) {
      return commands.filter((c) => c.cmd.startsWith(val));
    }
    return [];
  };

  const applyValue = (val: string, cur: number) => {
    setValue(val);
    setCursor(cur);
    setSuggestions(calcSuggestions(val));
    setSelIdx(-1);
  };

  // R-067: insert pasted text into the buffer and immediately submit it as a
  // single unit. We submit on paste-end rather than waiting for Enter because
  // the alternative — treating the paste as ordinary keystrokes — re-introduces
  // the multi-line-fragmentation bug this ticket exists to fix.
  const submitPaste = (pastedText: string) => {
    const newVal = value.slice(0, cursor) + pastedText + value.slice(cursor);
    setLastSubmitted(newVal);
    setDisabled(true);
    setValue('');
    setCursor(0);
    setSuggestions([]);
    setSelIdx(-1);
    setTimeout(() => events.emit('submit', newVal), 0);
  };

  useInput((input: string, key: Key) => {
    // R-067 — handle bracketed paste before any other key processing. The
    // terminal sends \x1b[200~…\x1b[201~ around pasted text; we accumulate
    // across chunks if necessary and submit the entire payload as one
    // multi-line message.
    if (pasteBufferRef.current !== null) {
      const cont = continueBracketedPaste(pasteBufferRef.current, input);
      if (cont.paste === null) {
        pasteBufferRef.current = cont.updatedBuffer;
        return;
      }
      pasteBufferRef.current = null;
      submitPaste(cont.paste);
      // Any keystrokes after the paste-end marker are dropped: once we have
      // submitted, the prompt is disabled and the AI loop owns input.
      return;
    }

    if (input && input.includes(PASTE_START)) {
      const parsed = parseBracketedPaste(input);
      if (parsed.paste !== null) {
        // Complete paste arrived in one chunk.
        submitPaste(parsed.paste);
        return;
      }
      if (parsed.pasteStarted) {
        // Open paste — buffer the fragment and wait for the end marker.
        pasteBufferRef.current = parsed.pasteFragment;
        // We intentionally discard `parsed.before` here: typical terminals
        // do not interleave keystrokes with the paste-start marker, and
        // mixing them in would surprise the submit-on-paste-end semantics.
        return;
      }
    }

    // Ctrl+C — always handled (even disabled), routes to external sigint handler
    if (key.ctrl && input === 'c') {
      events.emit('sigint');
      return;
    }

    // All other input ignored when disabled (AI is running)
    if (disabled) return;

    // Ctrl+D — EOF only when buffer is empty
    if (key.ctrl && input === 'd') {
      if (!value) {
        setDisabled(true);
        events.emit('submit_eof');
      }
      return;
    }

    // Enter — submit (use selected suggestion or raw value)
    if (key.return) {
      let final = value;
      if (selIdx >= 0 && suggestions[selIdx]) {
        final = suggestions[selIdx].cmd;
      }
      setLastSubmitted(final);
      setDisabled(true);
      setValue('');
      setCursor(0);
      setSuggestions([]);
      setSelIdx(-1);
      // Defer 'submit' until after React renders the disabled state. Without this,
      // nextLine() resolves synchronously (before Ink re-renders) and the AI loop
      // starts writing to stdout. Ink's subsequent \x1b[J clear then wipes the output.
      setTimeout(() => events.emit('submit', final), 0);
      return;
    }

    // Tab — autocomplete top suggestion
    if (key.tab) {
      const pick = selIdx >= 0 ? suggestions[selIdx] : suggestions[0];
      if (pick) {
        const completed = pick.cmd + ' ';
        applyValue(completed, completed.length);
      }
      return;
    }

    // ↑↓ — navigate suggestions or history
    if (key.upArrow) {
      if (suggestions.length > 0) {
        setSelIdx((prev) => Math.max(0, prev <= 0 ? suggestions.length - 1 : prev - 1));
      } else {
        const newIdx = Math.min(history.length - 1, histIdx + 1);
        if (newIdx !== histIdx) {
          if (histIdx === -1) setHistSaved(value);
          const entry = history[history.length - 1 - newIdx] ?? '';
          setValue(entry);
          setCursor(entry.length);
          setHistIdx(newIdx);
        }
      }
      return;
    }

    if (key.downArrow) {
      if (suggestions.length > 0 && selIdx >= 0) {
        setSelIdx((prev) => Math.min(suggestions.length - 1, prev + 1));
      } else if (histIdx > 0) {
        const newIdx = histIdx - 1;
        const entry = history[history.length - 1 - newIdx] ?? '';
        setValue(entry);
        setCursor(entry.length);
        setHistIdx(newIdx);
      } else if (histIdx === 0) {
        setValue(histSaved);
        setCursor(histSaved.length);
        setHistIdx(-1);
      }
      return;
    }

    // ← → cursor movement
    if (key.leftArrow) {
      setCursor((prev) => Math.max(0, prev - 1));
      return;
    }
    if (key.rightArrow) {
      setCursor((prev) => Math.min(value.length, prev + 1));
      return;
    }

    // Ctrl+A / Ctrl+E — line start/end
    if (key.ctrl && input === 'a') {
      setCursor(0);
      return;
    }
    if (key.ctrl && input === 'e') {
      setCursor(value.length);
      return;
    }

    // Ctrl+K — kill to end of line
    if (key.ctrl && input === 'k') {
      applyValue(value.slice(0, cursor), cursor);
      return;
    }

    // Ctrl+U — kill to start of line
    if (key.ctrl && input === 'u') {
      applyValue('', 0);
      return;
    }

    // Ctrl+W — kill word back
    if (key.ctrl && input === 'w') {
      const before = value.slice(0, cursor).trimEnd();
      const wordEnd = before.lastIndexOf(' ') + 1;
      const newVal = value.slice(0, wordEnd) + value.slice(cursor);
      applyValue(newVal, wordEnd);
      return;
    }

    // Backspace / Delete
    if (key.backspace || key.delete) {
      if (cursor > 0) {
        const newVal = value.slice(0, cursor - 1) + value.slice(cursor);
        applyValue(newVal, cursor - 1);
      }
      return;
    }

    // Regular character input
    if (input && !key.meta && !key.ctrl) {
      const newVal = value.slice(0, cursor) + input + value.slice(cursor);
      applyValue(newVal, cursor + input.length);
    }
  });

  // Render cursor: char under cursor shown in inverse video
  const before = value.slice(0, cursor);
  const atCursor = value[cursor] ?? ' ';
  const after = value.slice(cursor + 1);

  const SUGG_MAX = 8;
  const visibleSuggs = suggestions.slice(0, SUGG_MAX);

  // Build suggestion rows with group headers inserted
  const suggestionRows: Array<
    { type: 'group'; label: string } | { type: 'item'; cmd: SlashCmd; idx: number }
  > = [];
  let lastGroup: string | undefined = undefined;
  let itemIdx = 0;
  for (const s of visibleSuggs) {
    if (s.group !== undefined && s.group !== lastGroup) {
      suggestionRows.push({ type: 'group', label: s.group });
      lastGroup = s.group;
    }
    suggestionRows.push({ type: 'item', cmd: s, idx: itemIdx++ });
  }

  const sepDashes = columns;

  return (
    <Box flexDirection="column">
      {/* Urgent flash — drift/stale/plan_activated/review events, auto-clears after 30s */}
      {urgentFlash && (
        <Box>
          <Text color="red">{'  ⚠  '}</Text>
          <Text color="red">{urgentFlash}</Text>
        </Box>
      )}

      {/* Slash command suggestion menu */}
      {visibleSuggs.length > 0 && (
        <Box flexDirection="column" marginBottom={0} paddingLeft={2}>
          {suggestionRows.map((row, i) => {
            if (row.type === 'group') {
              return (
                <Text key={`g-${i}`} dimColor>
                  {'  '}── {row.label} ──
                </Text>
              );
            }
            const selected = row.idx === selIdx;
            return (
              <Box key={row.cmd.cmd}>
                <Text
                  color={selected ? 'white' : 'cyan'}
                  backgroundColor={selected ? 'blue' : undefined}
                >
                  {`  ${row.cmd.cmd.padEnd(20)}`}
                </Text>
                <Text dimColor={!selected} color={selected ? 'white' : undefined}>
                  {' '}
                  {row.cmd.desc}
                </Text>
              </Box>
            );
          })}
        </Box>
      )}

      {/* Top separator — full terminal width, like Claude Code */}
      <Text dimColor>{'─'.repeat(sepDashes)}</Text>

      {/* Input line */}
      {disabled ? (
        <Box>
          <Text dimColor>{promptStr}</Text>
          <Text dimColor>{lastSubmitted || '…'}</Text>
        </Box>
      ) : (
        <Box>
          <Text color="blueBright" bold>
            {promptStr}
          </Text>
          <Text>{before}</Text>
          <Text inverse>{atCursor}</Text>
          <Text>{after}</Text>
        </Box>
      )}

      {/* Bottom separator — full terminal width */}
      <Text dimColor>{'─'.repeat(sepDashes)}</Text>
    </Box>
  );
}

// ─── Non-TTY fallback reader (R-068) ──────────────────────────────────────────

/**
 * Read exactly one line from `input`, writing `prompt` to `output` first.
 *
 * Resolves to:
 *   - the typed line (without the trailing newline) when the user presses Enter
 *   - `null` when the input stream closes before a line arrives (EOF)
 *
 * Pure helper around Node's `readline`. Pulled out of {@link InkSession} so
 * tests can drive it with a {@link PassThrough} pair instead of stubbing
 * `process.stdin` / `process.stdout`.
 */
export function readSingleLine(
  prompt: string,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let settled = false;
    const rl = createInterface({ input, output });
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(value);
    };
    rl.question(prompt, (answer) => finish(answer));
    rl.on('close', () => finish(null));
  });
}

// ─── InkSession — same API as RawInput ───────────────────────────────────────

export class InkSession {
  private promptStr = '❯ ';
  private history: string[] = [];
  private events = new EventEmitter();
  private cmds: SlashCmd[];
  private instance: Instance | null = null;
  private paused = false;
  private notifLog: Notif[] = [];
  // Pause/resume gate: nextLine() waits for this before rendering Ink
  private resumeGate: Promise<void> | null = null;
  private resolveGate: (() => void) | null = null;

  // R-068: non-TTY fallback. Ink requires a real TTY for raw mode; piped or
  // redirected stdin (CI runs, `echo hi | plansync`, scripted tests) would
  // otherwise hang forever waiting for keypress events that will never arrive.
  // When stdin is not a TTY we switch to a plain readline-based reader that
  // emits one prompt per turn.
  private fallbackMode = false;

  /** Set by callers to intercept Ctrl+C during non-AI phases */
  onSigint: (() => void) | null = null;

  constructor(cmds: SlashCmd[]) {
    this.cmds = cmds;
    this.events.on('sigint', () => {
      this.onSigint?.();
    });
  }

  /** Load saved history (called once at startup). */
  start(savedHistory: string[]): void {
    this.history = [...savedHistory];
    // R-068: pin the fallback decision at startup. Re-evaluating inside
    // nextLine() each turn would defeat tests that swap stdin after
    // construction; pinning it also matches RawInput.start() semantics.
    this.fallbackMode = !process.stdin.isTTY;
  }

  /** Update the prompt string displayed to the left of the cursor. */
  setPrompt(p: string): void {
    // Leading newlines are visual spacing — strip them (Ink handles layout)
    this.promptStr = p.replace(/^\n+/, '');
    this.events.emit('setPrompt', this.promptStr);
  }

  /**
   * Push a notification to the log. Urgent events (drift, stale, plan_activated)
   * also emit a 5-second flash in the Ink prompt area.
   */
  setNotifyLine(text: string, urgent = false): void {
    this.notifLog.push({ text, ts: Date.now(), urgent });
    if (this.notifLog.length > 100) this.notifLog.shift();
    if (urgent && this.instance) {
      this.events.emit('urgentFlash', text);
    }
  }

  /** No-op — urgent flash auto-clears after 5s in PromptUI. */
  clearNotifyLine(): void {}

  /**
   * Render the Ink prompt and wait for the user to press Enter.
   * Returns the typed string, or null on EOF (Ctrl+D with empty buffer).
   * The Ink instance stays mounted between calls (persistent mode).
   * If paused (subprocess running), waits for resume() before rendering.
   */
  async nextLine(): Promise<string | null> {
    // Wait for any pending resume (e.g. /code subprocess still running)
    if (this.resumeGate) await this.resumeGate;
    if (this.paused) return null;

    // R-068: non-TTY fallback — pipes, redirects, CI runs.
    if (this.fallbackMode) {
      return this.fallbackReadLine();
    }

    if (!this.instance) {
      // First call (or after pause): mount the persistent Ink app
      this.instance = render(
        <PromptUI
          promptStr={this.promptStr}
          commands={this.cmds}
          history={this.history}
          events={this.events}
        />,
        { patchConsole: false },
      );
    } else {
      // Subsequent calls: re-enable input without remounting
      this.events.emit('reset');
    }

    return new Promise((resolve) => {
      let done = false;

      const finish = (value: string | null) => {
        if (done) return;
        done = true;
        this.events.off('submit', submitHandler);
        this.events.off('submit_eof', eofHandler);
        if (value !== null && value.trim()) {
          this.history.push(value);
          appendInputHistory(value);
        }
        resolve(value);
      };

      const submitHandler = (value: string) => finish(value);
      const eofHandler = () => finish(null);

      this.events.on('submit', submitHandler);
      this.events.on('submit_eof', eofHandler);
    });
  }

  /** Returns the notification log (entries within the last 10 min). */
  getNotifLog(): Notif[] {
    return this.notifLog.filter((n) => Date.now() - n.ts < NOTIF_TTL);
  }

  /**
   * Pause input before spawning a subprocess.
   * Unmounts Ink and gates nextLine() until resume() is called.
   */
  pause(): void {
    this.paused = true;
    // Create a gate that blocks nextLine() until resume() resolves it
    this.resumeGate = new Promise((resolve) => {
      this.resolveGate = resolve;
    });
    if (this.instance) {
      this.instance.unmount();
      this.instance = null;
    }
  }

  /** Resume input after a subprocess exits. */
  resume(): void {
    this.paused = false;
    // Unblock any nextLine() that was waiting for the subprocess to exit
    if (this.resolveGate) {
      this.resolveGate();
      this.resolveGate = null;
      this.resumeGate = null;
    }
  }

  /**
   * Unmount Ink before the AI loop runs. Ink freezes its last frame in place
   * (no clear), so the disabled-state echo stays visible. The AI writes below
   * the frozen frame. nextLine() will remount Ink below all AI output.
   * Unlike pause(), this does NOT set paused=true or block nextLine().
   */
  handoffToAI(): void {
    if (this.instance) {
      this.instance.unmount();
      this.instance = null;
    }
  }

  /** Clean shutdown — unmounts any active render. */
  stop(): void {
    this.paused = true;
    if (this.instance) {
      this.instance.unmount();
      this.instance = null;
    }
  }

  /**
   * Unmount Ink without setting paused=true. Use this before printing a
   * multi-line menu so the menu items are not hidden behind the Ink chrome.
   * Ink remounts automatically on the next nextLine() call.
   */
  unmountForMenu(): void {
    if (this.instance) {
      this.instance.unmount();
      this.instance = null;
    }
  }

  /**
   * Read one line of input via Node's readline (normal cooked mode).
   * Does not mount or unmount Ink — call unmountForMenu() first if needed.
   */
  rawReadLine(prompt: string): Promise<string> {
    return new Promise<string>((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question(prompt, (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  }

  /**
   * R-068: readline fallback used when stdin is not a TTY (piped input,
   * CI, scripted tests). Mirrors RawInput.fallbackReadLine — resolves to
   * the typed line, or null when stdin closes before a line is delivered.
   */
  private async fallbackReadLine(): Promise<string | null> {
    const value = await readSingleLine(this.promptStr, process.stdin, process.stdout);
    if (value !== null && value.trim()) {
      this.history.push(value);
      appendInputHistory(value);
    }
    return value;
  }

  /** R-068: exposed for tests — true when stdin was not a TTY at start(). */
  isFallbackMode(): boolean {
    return this.fallbackMode;
  }

  clearDisplay(): void {}
}
