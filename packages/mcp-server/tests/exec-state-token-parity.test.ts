/**
 * R-171: parity contract between the API canonical exec-state-token impl
 * and the MCP-server mirror.
 *
 * Both implementations are 20-line wrappers around `crypto.createHmac` +
 * base64url. They MUST stay byte-compatible so a token signed in the API
 * process verifies in the MCP process and vice versa. This test exists so
 * that if either implementation drifts (a stray `.digest('hex')`, a
 * different separator, a different schema check order) the build fails
 * loudly rather than at 2am when a tool call mysteriously rejects.
 *
 * Implementation note: we deliberately import the API source via a
 * relative path (not `@plansync/api`). The MCP server doesn't depend on
 * the API package and shouldn't start, but for test purposes Vite can
 * compile both TS files because they live in the same workspace and only
 * use `node:crypto` + `@plansync/shared`.
 */
import { describe, expect, it } from 'vitest';
import type { ExecStateTokenPayload } from '@plansync/shared';

import {
  signExecStateToken as mcpSign,
  verifyExecStateToken as mcpVerify,
} from '../src/exec-state-token';
import {
  signExecStateToken as apiSign,
  verifyExecStateToken as apiVerify,
} from '../../api/src/lib/exec-state-token';

const SECRET = 'parity-test-secret-XXXXXXXXXXXXXXXXXXXXXXXXXXX';
const ISSUED_AT = 1_700_000_000_000;

const payload: ExecStateTokenPayload = {
  v: 1,
  runId: 'run_parity',
  projectId: 'proj_parity',
  state: 'PACK_FETCHED',
  issuedAt: ISSUED_AT,
};

describe('R-171: API ↔ MCP exec-state-token parity', () => {
  it('produces byte-identical tokens for the same payload + secret', () => {
    const apiToken = apiSign(payload, SECRET);
    const mcpToken = mcpSign(payload, SECRET);
    expect(apiToken).toBe(mcpToken);
  });

  it('MCP can verify a token signed by API', () => {
    const apiToken = apiSign(payload, SECRET);
    const result = mcpVerify(apiToken, SECRET, ISSUED_AT + 1000);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload).toEqual(payload);
  });

  it('API can verify a token signed by MCP', () => {
    const mcpToken = mcpSign(payload, SECRET);
    const result = apiVerify(mcpToken, SECRET, ISSUED_AT + 1000);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload).toEqual(payload);
  });

  it('both reject the same tampered token with the same reason class', () => {
    const apiToken = apiSign(payload, SECRET);
    const [p, s] = apiToken.split('.');
    const tampered = p + '.' + s.slice(0, 5) + (s[5] === 'A' ? 'B' : 'A') + s.slice(6);
    const a = apiVerify(tampered, SECRET, ISSUED_AT + 1000);
    const m = mcpVerify(tampered, SECRET, ISSUED_AT + 1000);
    expect(a.ok).toBe(false);
    expect(m.ok).toBe(false);
    if (!a.ok && !m.ok) expect(a.reason).toBe(m.reason);
  });

  it('both produce the same expiry reason at the boundary', () => {
    const apiToken = apiSign(payload, SECRET);
    const veryFar = ISSUED_AT + 1_000 * 60 * 60 * 24 * 30; // 30 days
    const a = apiVerify(apiToken, SECRET, veryFar);
    const m = mcpVerify(apiToken, SECRET, veryFar);
    expect(a.ok).toBe(false);
    expect(m.ok).toBe(false);
    if (!a.ok && !m.ok) {
      expect(a.reason).toBe('EXPIRED');
      expect(m.reason).toBe('EXPIRED');
    }
  });
});
