/**
 * prompt.tsx — Ink-based interactive prompt for PlanSync Terminal.
 *
 * Persistent mode: the Ink instance stays mounted across turns.
 * Between turns, the input is disabled (shows "❯ …"). On the next
 * nextLine() call, a 'reset' event re-enables it.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput, render, type Instance } from 'ink';
import { EventEmitter } from 'events';
import { appendInputHistory } from './session.js';
import { type SlashCmd } from './input.js';

export type { SlashCmd };

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Notif {
  text: string;
  ts: number;
}

const NOTIF_TTL = 10 * 60 * 1000; // 10 minutes in ms

function ageStr(ts: number): string {
  const mins = Math.floor((Date.now() - ts) / 60_000);
  return mins === 0 ? 'just now' : `${mins}m ago`;
}

// ─── PromptUI component ───────────────────────────────────────────────────────

interface PromptProps {
  promptStr: string;
  commands: SlashCmd[];
  history: string[];
  events: EventEmitter;
  initialStatusLine?: string;
  initialNotifs?: Notif[];
}

function PromptUI({
  promptStr: initialPrompt,
  commands,
  history,
  events,
  initialStatusLine,
  initialNotifs,
}: PromptProps) {
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);
  const [histIdx, setHistIdx] = useState(-1);
  const [histSaved, setHistSaved] = useState('');
  const [suggestions, setSuggestions] = useState<SlashCmd[]>([]);
  const [selIdx, setSelIdx] = useState(-1);
  const [notifs, setNotifs] = useState<Notif[]>(
    (initialNotifs ?? []).filter((n) => Date.now() - n.ts < NOTIF_TTL),
  );
  const [statusLine, setStatusLine] = useState(initialStatusLine ?? '');
  const [promptStr, setPromptStr] = useState(initialPrompt);
  const [disabled, setDisabled] = useState(false);

  useEffect(() => {
    const handler = (text: string) =>
      setNotifs((prev) => [
        ...prev.filter((n) => Date.now() - n.ts < NOTIF_TTL).slice(-4),
        { text, ts: Date.now() },
      ]);
    events.on('notify', handler);
    return () => {
      events.off('notify', handler);
    };
  }, [events]);

  // Auto-expire notifications every minute
  useEffect(() => {
    const id = setInterval(() => {
      setNotifs((prev) => prev.filter((n) => Date.now() - n.ts < NOTIF_TTL));
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const handler = (line: string) => setStatusLine(line);
    events.on('statusLine', handler);
    return () => {
      events.off('statusLine', handler);
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

  useInput((input, key) => {
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
      setDisabled(true);
      setValue('');
      setCursor(0);
      setSuggestions([]);
      setSelIdx(-1);
      events.emit('submit', final);
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

  return (
    <Box flexDirection="column">
      {/* Recent notifications with age */}
      {notifs.map((n, i) => (
        <Box key={i}>
          <Text color="yellow">{n.text}</Text>
          <Text dimColor>{'  ' + ageStr(n.ts)}</Text>
        </Box>
      ))}

      {/* Live status line */}
      {statusLine ? <Text dimColor> {statusLine}</Text> : null}

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

      {/* Input line */}
      {disabled ? (
        <Text dimColor>{promptStr}…</Text>
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
    </Box>
  );
}

// ─── InkSession — same API as RawInput ───────────────────────────────────────

export class InkSession {
  private promptStr = '❯ ';
  private history: string[] = [];
  private events = new EventEmitter();
  private cmds: SlashCmd[];
  private instance: Instance | null = null;
  private paused = false;
  private statusLine = '';
  private notifLog: Notif[] = [];
  // Pause/resume gate: nextLine() waits for this before rendering Ink
  private resumeGate: Promise<void> | null = null;
  private resolveGate: (() => void) | null = null;

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
  }

  /** Update the prompt string displayed to the left of the cursor. */
  setPrompt(p: string): void {
    // Leading newlines are visual spacing — strip them (Ink handles layout)
    this.promptStr = p.replace(/^\n+/, '');
    this.events.emit('setPrompt', this.promptStr);
  }

  /** Update the live status line shown above the input. */
  setStatus(line: string): void {
    this.statusLine = line;
    this.events.emit('statusLine', line);
  }

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

    if (!this.instance) {
      // First call (or after pause): mount the persistent Ink app
      this.instance = render(
        <PromptUI
          promptStr={this.promptStr}
          commands={this.cmds}
          history={this.history}
          events={this.events}
          initialStatusLine={this.statusLine}
          initialNotifs={this.notifLog.filter((n) => Date.now() - n.ts < NOTIF_TTL)}
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
   * Print a message above the current input line without corrupting it.
   * If no prompt is active, writes directly to stdout.
   */
  printAbove(text: string): void {
    this.notifLog.push({ text, ts: Date.now() });
    if (this.notifLog.length > 100) this.notifLog.shift();
    if (this.instance) {
      this.events.emit('notify', text);
    } else {
      process.stdout.write(text + '\n');
    }
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

  /** Clean shutdown — unmounts any active render. */
  stop(): void {
    this.paused = true;
    if (this.instance) {
      this.instance.unmount();
      this.instance = null;
    }
  }

  clearDisplay(): void {}
}
