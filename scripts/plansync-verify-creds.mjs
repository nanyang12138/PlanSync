#!/usr/bin/env node
// Standalone helper used by bin/plansync to verify credentials against
// /api/auth/verify. Extracted from inline `node -e` blocks so that the
// http/https module selection can be unit-tested (R-026).
//
// Required env vars:
//   PLANSYNC_VERIFY_URL  Base URL (http or https, with optional port)
//   PLANSYNC_VERIFY_USER User name to verify
//   PLANSYNC_VERIFY_PASS Password (or API key) to verify
//
// Optional env vars:
//   PLANSYNC_VERIFY_MODE "simple"  -> stdout "ok" | "fail"   (existing-creds fast path)
//                        "full"    -> stdout "ok" | "new" | "ERR:<msg>" (first-time flow)
//                        default: "full"
//
// The script never reads stdin, never writes to stderr, and exits 0 even on
// API failure — callers parse stdout exactly like the previous inline
// implementation in bin/plansync.

import http from 'node:http';
import https from 'node:https';

const url = process.env.PLANSYNC_VERIFY_URL;
const userName = process.env.PLANSYNC_VERIFY_USER;
const password = process.env.PLANSYNC_VERIFY_PASS;
const mode = process.env.PLANSYNC_VERIFY_MODE === 'simple' ? 'simple' : 'full';

if (!url || !userName || password === undefined) {
  process.stdout.write(mode === 'simple' ? 'fail' : 'ERR:missing required env vars');
  process.exit(0);
}

let parsed;
try {
  parsed = new URL('/api/auth/verify', url);
} catch (err) {
  process.stdout.write(mode === 'simple' ? 'fail' : `ERR:invalid URL: ${err.message}`);
  process.exit(0);
}

// Pick http or https module + default port based on URL protocol.
// Previously bin/plansync hardcoded require('http') + port||80, which broke
// any https deployment (the request would hang until socket timeout).
const isHttps = parsed.protocol === 'https:';
const mod = isHttps ? https : http;
const defaultPort = isHttps ? 443 : 80;

const body = JSON.stringify({ userName, password });

const req = mod.request(
  {
    hostname: parsed.hostname,
    port: parsed.port || defaultPort,
    path: parsed.pathname + (parsed.search || ''),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  },
  (res) => {
    let buf = '';
    res.on('data', (chunk) => {
      buf += chunk;
    });
    res.on('end', () => {
      if (mode === 'simple') {
        try {
          process.stdout.write(JSON.parse(buf).success ? 'ok' : 'fail');
        } catch {
          process.stdout.write('fail');
        }
        return;
      }
      try {
        const j = JSON.parse(buf);
        if (j.success) {
          process.stdout.write(j.isNewUser ? 'new' : 'ok');
        } else {
          process.stdout.write('ERR:' + (j.error || 'unknown error'));
        }
      } catch {
        process.stdout.write('ERR:invalid response');
      }
    });
  },
);

req.on('error', (err) => {
  if (mode === 'simple') {
    process.stdout.write('fail');
  } else {
    process.stdout.write('ERR:' + err.message);
  }
});

req.write(body);
req.end();
