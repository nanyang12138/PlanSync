// Test for scripts/plansync-verify-creds.mjs — verifies that the credential
// verification helper selects the correct http/https module based on the URL
// protocol (R-026).
//
// Strategy: spin up a real http and a real https server (using a fixture
// self-signed cert), spawn the helper script against each, and assert it
// reaches the server and parses the response correctly.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT_PATH = resolve(__dirname, '../../..', 'scripts', 'plansync-verify-creds.mjs');
const FIXTURE_CERT = readFileSync(resolve(__dirname, 'fixtures/test-cert.pem'), 'utf8');
const FIXTURE_KEY = readFileSync(resolve(__dirname, 'fixtures/test-key.pem'), 'utf8');

interface VerifyServer {
  baseUrl: string;
  close: () => Promise<void>;
  requests: Array<{ method?: string; url?: string; body: unknown }>;
}

function startServer(
  kind: 'http' | 'https',
  responder: (body: { userName: string; password: string }) => unknown,
): Promise<VerifyServer> {
  const requests: VerifyServer['requests'] = [];
  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let parsed: { userName: string; password: string };
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        parsed = { userName: '', password: '' };
      }
      requests.push({ method: req.method, url: req.url, body: parsed });
      const payload = responder(parsed);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  };

  const server =
    kind === 'http'
      ? http.createServer(handler)
      : https.createServer({ cert: FIXTURE_CERT, key: FIXTURE_KEY }, handler);

  return new Promise<VerifyServer>((res) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      res({
        baseUrl: `${kind}://127.0.0.1:${addr.port}`,
        requests,
        close: () =>
          new Promise<void>((resolve, reject) =>
            server.close((err) => (err ? reject(err) : resolve())),
          ),
      });
    });
  });
}

function runHelper(
  url: string,
  mode: 'simple' | 'full',
  user = 'alice',
  pass = 'pw',
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT_PATH], {
      env: {
        ...process.env,
        PLANSYNC_VERIFY_URL: url,
        PLANSYNC_VERIFY_USER: user,
        PLANSYNC_VERIFY_PASS: pass,
        PLANSYNC_VERIFY_MODE: mode,
        // Helper is talking to a self-signed test cert, so disable TLS verify
        // strictly for the helper subprocess. Production deployments use a
        // real cert and do not need this.
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c.toString()));
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('scripts/plansync-verify-creds.mjs (R-026)', () => {
  let httpServer: VerifyServer;
  let httpsServer: VerifyServer;

  beforeAll(async () => {
    httpServer = await startServer('http', ({ userName, password }) => ({
      success: userName === 'alice' && password === 'pw',
      isNewUser: false,
    }));
    httpsServer = await startServer('https', ({ userName, password }) => ({
      success: userName === 'alice' && password === 'pw',
      isNewUser: true,
    }));
  });

  afterAll(async () => {
    await httpServer.close();
    await httpsServer.close();
  });

  it('uses http module for http:// URLs (simple mode)', async () => {
    const { stdout } = await runHelper(httpServer.baseUrl, 'simple');
    expect(stdout).toBe('ok');
    expect(httpServer.requests.length).toBeGreaterThan(0);
    expect(httpServer.requests.at(-1)?.url).toBe('/api/auth/verify');
    expect(httpServer.requests.at(-1)?.body).toEqual({ userName: 'alice', password: 'pw' });
  });

  it('uses https module for https:// URLs (full mode)', async () => {
    const { stdout } = await runHelper(httpsServer.baseUrl, 'full');
    expect(stdout).toBe('new');
    expect(httpsServer.requests.length).toBeGreaterThan(0);
    expect(httpsServer.requests.at(-1)?.body).toEqual({ userName: 'alice', password: 'pw' });
  });

  it('returns fail in simple mode when credentials are rejected', async () => {
    const { stdout } = await runHelper(httpServer.baseUrl, 'simple', 'alice', 'wrong');
    expect(stdout).toBe('fail');
  });

  it('returns ERR:<msg> in full mode for invalid URL', async () => {
    const { stdout } = await runHelper('not-a-url', 'full');
    expect(stdout.startsWith('ERR:')).toBe(true);
  });

  it('returns ERR:<connection error> when https server is unreachable', async () => {
    // Use an unroutable port; ECONNREFUSED is reported via req.on('error').
    const { stdout } = await runHelper('https://127.0.0.1:1', 'full');
    expect(stdout.startsWith('ERR:')).toBe(true);
  });
});
