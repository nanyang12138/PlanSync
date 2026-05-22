/**
 * Tests for R-066 — the Ink-based PromptUI must re-render its top/bottom
 * separator lines when the user resizes the terminal window.
 *
 * Rather than mounting Ink (which would require an extra testing dep), this
 * suite pins down the small `subscribeToResize` helper that PromptUI relies
 * on inside its `useEffect`. The helper is the only piece that talks to the
 * Node stream directly; the React side is a straightforward
 * `setColumns(stream.columns)` call.
 *
 * The contract being pinned down:
 *
 *   1. `subscribeToResize` registers a `'resize'` listener on the provided
 *      stream and invokes the handler each time the stream emits it.
 *   2. The returned teardown removes the listener — no zombie subscriptions
 *      after the component unmounts.
 *   3. `getTerminalColumns` returns the stream's reported width, falling
 *      back to 80 when the stream is not size-aware (e.g. piped output).
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { getTerminalColumns, subscribeToResize } from '../src/prompt.js';

type FakeStream = EventEmitter & { columns?: number };

function makeStream(initialCols?: number): FakeStream {
  const stream = new EventEmitter() as FakeStream;
  if (initialCols !== undefined) stream.columns = initialCols;
  return stream;
}

describe('R-066 — terminal resize plumbing', () => {
  it('subscribeToResize forwards resize events to the handler', () => {
    const stream = makeStream(80);
    const handler = vi.fn();

    const teardown = subscribeToResize(handler, stream as unknown as NodeJS.WriteStream);

    stream.emit('resize');
    stream.emit('resize');

    expect(handler).toHaveBeenCalledTimes(2);

    teardown();
  });

  it('teardown removes the listener so further resizes are ignored', () => {
    const stream = makeStream(80);
    const handler = vi.fn();

    const teardown = subscribeToResize(handler, stream as unknown as NodeJS.WriteStream);
    stream.emit('resize');
    teardown();

    stream.emit('resize');
    stream.emit('resize');

    expect(handler).toHaveBeenCalledTimes(1);
    expect(stream.listenerCount('resize')).toBe(0);
  });

  it('getTerminalColumns reads the live stream width on each call', () => {
    const stream = makeStream(120);

    expect(getTerminalColumns(stream as unknown as NodeJS.WriteStream)).toBe(120);

    stream.columns = 42;
    expect(getTerminalColumns(stream as unknown as NodeJS.WriteStream)).toBe(42);
  });

  it('getTerminalColumns falls back to 80 for non-TTY streams', () => {
    const stream = makeStream();
    expect(getTerminalColumns(stream as unknown as NodeJS.WriteStream)).toBe(80);
  });
});
