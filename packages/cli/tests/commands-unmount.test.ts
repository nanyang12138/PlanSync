/**
 * Tests for R-065 — slash commands that print multi-line output must call
 * `ctx.rawInput.unmountForMenu()` BEFORE writing to stdout. Without that,
 * the still-mounted Ink instance can hide or overwrite the printed lines,
 * producing the "UI mis-alignment" symptom in the REPL.
 *
 * The contract this suite pins down:
 *
 *   1. The command calls `unmountForMenu` exactly when (or before) it
 *      produces its own multi-line console output.
 *   2. `unmountForMenu` happens before the first `console.log` from the
 *      handler — never after — so the lines below the Ink frame are visible.
 *
 * We instantiate a fake CommandContext and assert call ordering using a
 * shared `events` array. The slash handler's surface area is small enough
 * that the test does not need a real Ink session or a real MCP server.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleSlashCommand, type CommandContext } from '../src/commands.js';
import type { Message } from '../src/ai-loop.js';

type Event = { kind: 'unmount' | 'log'; line: string };

function makeCtx(overrides: Partial<CommandContext> = {}): {
  ctx: CommandContext;
  events: Event[];
  logSpy: ReturnType<typeof vi.spyOn>;
} {
  const events: Event[] = [];

  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    events.push({ kind: 'log', line: args.map((a) => String(a)).join(' ') });
  });

  const rawInput = {
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    clearDisplay: vi.fn(),
    onSigint: null,
    unmountForMenu: vi.fn(() => {
      events.push({ kind: 'unmount', line: '' });
    }),
    rawReadLine: vi.fn(async () => ''),
  };

  const ctx = {
    rawInput,
    mcp: {
      stop: vi.fn(),
      start: vi.fn(),
      getAnthropicTools: () => [],
      callTool: vi.fn(),
    } as unknown as CommandContext['mcp'],
    getStatus: () => ({}) as ReturnType<CommandContext['getStatus']>,
    setStatus: vi.fn(),
    getSystem: () => '',
    history: [] as Message[],
    currentSessionId: 'sess-test',
    getNotifLog: () => [],
    ask: async () => '',
    ...overrides,
  } as CommandContext;

  return { ctx, events, logSpy };
}

describe('handleSlashCommand — R-065 unmount before multi-line output', () => {
  let restored: Array<() => void> = [];

  beforeEach(() => {
    restored = [];
  });

  afterEach(() => {
    restored.forEach((fn) => fn());
    vi.restoreAllMocks();
  });

  it('/clear unmounts Ink before logging the cleared-message', async () => {
    const { ctx, events, logSpy } = makeCtx({ history: [{ role: 'user', content: 'x' }] });
    restored.push(() => logSpy.mockRestore());

    const result = await handleSlashCommand('/clear', ctx);

    expect(result).toBe('handled');
    expect(ctx.history).toHaveLength(0);
    expect(ctx.rawInput.unmountForMenu).toHaveBeenCalledTimes(1);

    // The unmount must happen before the first console.log so the cleared
    // message is not hidden behind the Ink frame.
    const firstLog = events.findIndex((e) => e.kind === 'log');
    const firstUnmount = events.findIndex((e) => e.kind === 'unmount');
    expect(firstUnmount).toBeGreaterThanOrEqual(0);
    expect(firstLog).toBeGreaterThanOrEqual(0);
    expect(firstUnmount).toBeLessThan(firstLog);
    expect(events[firstLog].line).toMatch(/cleared/i);
  });

  it('/verbose unmounts Ink before logging the toggled state', async () => {
    const { ctx, events, logSpy } = makeCtx();
    restored.push(() => logSpy.mockRestore());

    const result = await handleSlashCommand('/verbose', ctx);

    expect(result).toBe('handled');
    expect(ctx.rawInput.unmountForMenu).toHaveBeenCalledTimes(1);

    const firstLog = events.findIndex((e) => e.kind === 'log');
    const firstUnmount = events.findIndex((e) => e.kind === 'unmount');
    expect(firstUnmount).toBeGreaterThanOrEqual(0);
    expect(firstLog).toBeGreaterThanOrEqual(0);
    expect(firstUnmount).toBeLessThan(firstLog);
    expect(events[firstLog].line).toMatch(/verbose/i);
  });

  it('/exec without taskId unmounts Ink before logging usage', async () => {
    const { ctx, events, logSpy } = makeCtx();
    restored.push(() => logSpy.mockRestore());

    const result = await handleSlashCommand('/exec', ctx);

    expect(result).toBe('handled');
    expect(ctx.rawInput.unmountForMenu).toHaveBeenCalledTimes(1);

    const firstLog = events.findIndex((e) => e.kind === 'log');
    const firstUnmount = events.findIndex((e) => e.kind === 'unmount');
    expect(firstUnmount).toBeLessThan(firstLog);
    expect(events[firstLog].line).toMatch(/Usage: \/exec/);
    // /exec did not actually launch — pause/resume must not have fired.
    expect(ctx.rawInput.pause).not.toHaveBeenCalled();
    expect(ctx.rawInput.resume).not.toHaveBeenCalled();
  });

  it('returns "unknown" for unhandled commands without touching unmount/log', async () => {
    const { ctx, events, logSpy } = makeCtx();
    restored.push(() => logSpy.mockRestore());

    const result = await handleSlashCommand('/definitely-not-a-command', ctx);

    expect(result).toBe('unknown');
    expect(ctx.rawInput.unmountForMenu).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });
});
