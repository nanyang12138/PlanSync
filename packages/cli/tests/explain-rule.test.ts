/**
 * R-184: `/explain rule <id>` command — surfaces the verification rule
 * details that the complete route's 422 envelope (gate === 'rule') points
 * at. Without this command, an agent that hits a rule-gate failure has
 * the ruleId but no human-readable description of what the rule asks the
 * run to prove; with it, the agent / user can self-serve before re-trying.
 *
 * Contract pinned down here:
 *   1. Wrong/missing argument → usage line printed, no API call made.
 *   2. Rule found             → `kind`, `scope`, `params`, and a
 *                                human-readable explanation are printed
 *                                in that order, AFTER `unmountForMenu`
 *                                (the R-065 pattern that all multi-line
 *                                slash commands follow).
 *   3. Rule not found         → "not found" line, exit clean.
 *
 * The HTTP transport is intercepted at `api-errors.performRequest` (the
 * same shape `psRequest` ultimately calls) so the test never opens a
 * socket. cfg.project / cfg.user are patched so the command does not
 * short-circuit on "no project selected".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// IMPORTANT: vi.mock is hoisted, so we need a side-channel to swap in
// per-test responses. The factory below references `mockState` indirectly
// via a getter on the module so each test can drive the next response.
const mockState: {
  nextRules: Array<Record<string, unknown>> | Error;
  calls: Array<{ method: string; path: string }>;
} = { nextRules: [], calls: [] };

vi.mock('../src/api-errors.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api-errors.js')>(
    '../src/api-errors.js',
  );
  return {
    ...actual,
    performRequest: vi.fn(async (method: string, path: string) => {
      mockState.calls.push({ method, path });
      if (mockState.nextRules instanceof Error) throw mockState.nextRules;
      return { data: mockState.nextRules };
    }),
  };
});

import { handleSlashCommand, type CommandContext } from '../src/commands.js';
import type { Message } from '../src/ai-loop.js';
import { cfg } from '../src/config.js';

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

describe('R-184: /explain rule <id>', () => {
  let restored: Array<() => void> = [];
  let savedProject: string;
  let savedUser: string;
  let savedKey: string;
  let savedApiUrl: string;

  beforeEach(() => {
    restored = [];
    mockState.nextRules = [];
    mockState.calls = [];
    savedProject = cfg.project;
    savedUser = cfg.user;
    savedKey = cfg.apiKey;
    savedApiUrl = cfg.apiUrl;
    cfg.project = 'proj-r184';
    cfg.user = 'r184-owner';
    cfg.apiKey = 'test-key';
    cfg.apiUrl = 'http://localhost:0';
  });

  afterEach(() => {
    restored.forEach((fn) => fn());
    cfg.project = savedProject;
    cfg.user = savedUser;
    cfg.apiKey = savedKey;
    cfg.apiUrl = savedApiUrl;
    vi.restoreAllMocks();
  });

  it('prints usage when no rule id is given and never hits the API', async () => {
    const { ctx, events, logSpy } = makeCtx();
    restored.push(() => logSpy.mockRestore());

    const result = await handleSlashCommand('/explain', ctx);

    expect(result).toBe('handled');
    // Usage line is printed AFTER unmount (R-065 pattern).
    const firstLog = events.findIndex((e) => e.kind === 'log');
    const firstUnmount = events.findIndex((e) => e.kind === 'unmount');
    expect(firstUnmount).toBeGreaterThanOrEqual(0);
    expect(firstUnmount).toBeLessThan(firstLog);
    expect(events[firstLog].line).toMatch(/Usage: \/explain rule/);
    // Critically: no API call was made — usage path is purely local.
    expect(mockState.calls).toHaveLength(0);
  });

  it('prints usage when the sub-command is wrong (e.g. "/explain task xyz")', async () => {
    const { ctx, events, logSpy } = makeCtx();
    restored.push(() => logSpy.mockRestore());

    const result = await handleSlashCommand('/explain task abc-123', ctx);

    expect(result).toBe('handled');
    const firstLog = events.findIndex((e) => e.kind === 'log');
    expect(events[firstLog].line).toMatch(/Usage: \/explain rule/);
    expect(mockState.calls).toHaveLength(0);
  });

  it('prints kind / scope / params / explanation when the rule is found', async () => {
    const { ctx, events, logSpy } = makeCtx();
    restored.push(() => logSpy.mockRestore());

    mockState.nextRules = [
      {
        id: 'rule-abc',
        kind: 'min_output_summary_chars',
        scope: 'project',
        scopeValue: null,
        params: { min: 100 },
        enabled: true,
      },
      {
        id: 'rule-xyz',
        kind: 'require_files_changed',
        scope: 'project',
        scopeValue: null,
        params: {},
        enabled: false,
      },
    ];

    const result = await handleSlashCommand('/explain rule rule-abc', ctx);

    expect(result).toBe('handled');
    expect(mockState.calls).toHaveLength(1);
    expect(mockState.calls[0].method).toBe('GET');
    expect(mockState.calls[0].path).toBe('/api/projects/proj-r184/verification-rules');

    // The four key blocks: kind, scope, params, and the human
    // explanation. Each must appear at least once after the unmount.
    const lines = events.filter((e) => e.kind === 'log').map((e) => e.line);
    expect(lines.some((l) => /min_output_summary_chars/.test(l))).toBe(true);
    expect(lines.some((l) => /scope/.test(l) && /project/.test(l))).toBe(true);
    expect(lines.some((l) => /"min":\s*100/.test(l) || /\{"min":100\}/.test(l))).toBe(true);
    // The explanation copy comes from the local `explainRuleKind` map.
    // The actual copy embeds "params.min" inside backticks, so we match
    // on the surrounding "characters long" suffix to stay robust to
    // future copy edits.
    expect(lines.some((l) => /params\.min.*characters long/.test(l))).toBe(true);
    // The hard-gate hint line — keeps the user oriented about WHY
    // they're staring at this rule (because complete returned 422
    // with gate==='rule').
    expect(lines.some((l) => /gate === 'rule'/.test(l))).toBe(true);
  });

  it('prints "not found" when the ruleId does not match any project rule', async () => {
    const { ctx, events, logSpy } = makeCtx();
    restored.push(() => logSpy.mockRestore());

    mockState.nextRules = [
      {
        id: 'some-other-rule',
        kind: 'require_files_changed',
        scope: 'project',
        scopeValue: null,
        params: {},
        enabled: true,
      },
    ];

    const result = await handleSlashCommand('/explain rule rule-missing', ctx);

    expect(result).toBe('handled');
    expect(mockState.calls).toHaveLength(1);
    const lines = events.filter((e) => e.kind === 'log').map((e) => e.line);
    expect(lines.some((l) => /not found/i.test(l))).toBe(true);
  });
});
