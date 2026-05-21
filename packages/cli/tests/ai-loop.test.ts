/**
 * Tests for R-063 — AI loop must preserve tool_use / tool_result blocks in
 * the conversation history so follow-up turns can reference the results of
 * earlier tool calls.
 *
 * The streaming HTTP path in `runAgentLoop` requires a real LLM connection
 * and is not exercised here; instead we cover the two pure helpers that
 * encode the contract:
 *
 *   - `estimateTokens` — the cheap chars/4 budget estimator.
 *   - `pruneHistory`  — token-budgeted trimming that must never split an
 *     `assistant{tool_use}` / `user{tool_result}` pair.
 *
 * If the loop stops persisting tool blocks (regressing R-063) the second
 * suite still pins down the structural invariant the index.ts caller now
 * relies on: keeping tool_use and tool_result blocks side-by-side under
 * pressure.
 */

import { describe, it, expect } from 'vitest';
import { estimateTokens, pruneHistory, type Message } from '../src/ai-loop.js';

const text = (s: string): Message => ({ role: 'user', content: s });
const reply = (s: string): Message => ({ role: 'assistant', content: s });
const toolUse = (id: string, name = 'plansync_status', input = {}): Message => ({
  role: 'assistant',
  content: [
    { type: 'text', text: 'calling tool…' },
    { type: 'tool_use', id, name, input },
  ],
});
const toolResult = (id: string, body = 'ok'): Message => ({
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: id, content: body }],
});

describe('estimateTokens (R-063)', () => {
  it('returns 0 for empty/null content', () => {
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
    expect(estimateTokens('')).toBe(0);
  });

  it('approximates strings as chars / 4', () => {
    expect(estimateTokens('a'.repeat(4))).toBe(1);
    expect(estimateTokens('a'.repeat(40))).toBe(10);
    expect(estimateTokens('a'.repeat(41))).toBe(11);
  });

  it('serialises structured content before counting', () => {
    const blocks = [
      { type: 'text', text: 'hi' },
      { type: 'tool_use', id: 'x', name: 'plansync_status', input: { projectId: 'p1' } },
    ];
    const expected = Math.ceil(JSON.stringify(blocks).length / 4);
    expect(estimateTokens(blocks)).toBe(expected);
  });
});

describe('pruneHistory (R-063)', () => {
  it('leaves history untouched when under budget', () => {
    const history: Message[] = [text('hi'), reply('hello')];
    const snapshot = JSON.stringify(history);
    pruneHistory(history, 1000);
    expect(JSON.stringify(history)).toBe(snapshot);
    expect(history).toHaveLength(2);
  });

  it('drops the oldest user/assistant pair when over budget', () => {
    const big = 'x'.repeat(4000); // ~1000 tokens each
    const history: Message[] = [
      text(big),
      reply(big),
      text('recent user'),
      reply('recent assistant'),
    ];
    pruneHistory(history, 600);
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history[0].role).toBe('user');
    expect(typeof history[0].content).toBe('string');
    expect(history[0].content as string).toMatch(/truncated/);
    expect(history[history.length - 1].content).toBe('recent assistant');
  });

  it('keeps tool_use and its tool_result together when trimming', () => {
    // Layout: [stale user, assistant tool_use, user tool_result, recent user, recent assistant]
    // With a tight budget the first user message should be replaced by a summary
    // stub, but the assistant{tool_use} / user{tool_result} pair must NOT be
    // separated. If one is dropped, the other must go too — otherwise Anthropic
    // rejects the request because a tool_result has no matching tool_use.
    const big = 'x'.repeat(4000);
    const history: Message[] = [
      text(big),
      toolUse('call-1'),
      toolResult('call-1', big),
      text('latest'),
      reply('done'),
    ];
    pruneHistory(history, 800);

    const idxToolUse = history.findIndex(
      (m) =>
        m.role === 'assistant' &&
        Array.isArray(m.content) &&
        m.content.some(
          (b) => typeof b === 'object' && b !== null && (b as { type?: string }).type === 'tool_use',
        ),
    );
    const idxToolResult = history.findIndex(
      (m) =>
        m.role === 'user' &&
        Array.isArray(m.content) &&
        m.content.some(
          (b) =>
            typeof b === 'object' && b !== null && (b as { type?: string }).type === 'tool_result',
        ),
    );
    // Either both pruned, or both kept and adjacent.
    if (idxToolUse === -1 || idxToolResult === -1) {
      expect(idxToolUse).toBe(-1);
      expect(idxToolResult).toBe(-1);
    } else {
      expect(idxToolResult).toBe(idxToolUse + 1);
    }
  });

  it('handles an empty history without throwing', () => {
    const history: Message[] = [];
    expect(() => pruneHistory(history, 10)).not.toThrow();
    expect(history).toEqual([]);
  });

  it('replaces dropped messages with a single summary stub', () => {
    const big = 'x'.repeat(4000);
    const history: Message[] = [
      text(big),
      reply(big),
      text(big),
      reply(big),
      text('keep me'),
      reply('keep me too'),
    ];
    pruneHistory(history, 500);
    const summaryMatches = history.filter(
      (m) => typeof m.content === 'string' && /truncated/.test(m.content as string),
    );
    expect(summaryMatches.length).toBe(1);
  });
});
