/**
 * Session persistence for PlanSync Terminal.
 *
 * Each conversation is a separate session with a unique ID.
 * Sessions are stored as JSONL files:
 *   ~/.plansync/sessions/<projectId>/<sessionId>.jsonl
 *
 * File format:
 *   Line 1: {"_meta":true,"id":"...","projectId":"...","startedAt":"..."}
 *   Line N: {"role":"user"|"assistant","content":...,"ts":1234567890}
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import crypto from 'crypto';
import { Message } from './ai-loop.js';

const BASE_DIR = path.join(os.homedir(), '.plansync');
const SESSIONS_BASE = path.join(BASE_DIR, 'sessions');
const HISTORY_FILE = path.join(BASE_DIR, 'history');
const MAX_SESSIONS = 20;

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function projectDir(projectId: string): string {
  const safe = projectId.replace(/[^a-z0-9_-]/gi, '_');
  const dir = path.join(SESSIONS_BASE, safe);
  ensureDir(dir);
  return dir;
}

function sessionFilePath(projectId: string, sessionId: string): string {
  return path.join(projectDir(projectId), `${sessionId}.jsonl`);
}

// ─── Session metadata ─────────────────────────────────────────────────────────

interface SessionMeta {
  id: string;
  startedAt: string;
  messageCount: number;
}

function readMeta(filePath: string): SessionMeta | null {
  try {
    const firstLine = fs.readFileSync(filePath, 'utf8').split('\n')[0];
    const obj = JSON.parse(firstLine);
    if (!obj._meta) return null;
    // Count message lines (skip meta line and blanks)
    const lines = fs
      .readFileSync(filePath, 'utf8')
      .split('\n')
      .filter((l) => l.trim());
    const messageCount = lines.slice(1).filter((l) => {
      try {
        const o = JSON.parse(l);
        return o.role === 'user' || o.role === 'assistant';
      } catch {
        return false;
      }
    }).length;
    return { id: obj.id, startedAt: obj.startedAt, messageCount };
  } catch {
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Create a new session for the given project.
 * Returns the session ID.
 */
export function startSession(projectId: string): string {
  if (!projectId) return '';
  const id = crypto.randomBytes(4).toString('hex'); // short 8-char ID like "a1b2c3d4"
  const filePath = sessionFilePath(projectId, id);
  const meta = { _meta: true, id, projectId, startedAt: new Date().toISOString() };
  try {
    fs.writeFileSync(filePath, JSON.stringify(meta) + '\n', 'utf8');
    pruneOldSessions(projectId);
  } catch {
    /* best-effort */
  }
  return id;
}

/**
 * Append a user+assistant message pair to the session.
 */
export function appendToSession(
  projectId: string,
  sessionId: string,
  userMsg: Message,
  assistantMsg: Message,
): void {
  if (!projectId || !sessionId) return;
  const filePath = sessionFilePath(projectId, sessionId);
  try {
    const line1 = JSON.stringify({ role: userMsg.role, content: userMsg.content, ts: Date.now() });
    const line2 = JSON.stringify({
      role: assistantMsg.role,
      content: assistantMsg.content,
      ts: Date.now(),
    });
    fs.appendFileSync(filePath, line1 + '\n' + line2 + '\n', 'utf8');
  } catch {
    /* best-effort */
  }
}

/**
 * List all sessions for a project, newest first.
 */
export function listSessions(projectId: string): SessionMeta[] {
  if (!projectId) return [];
  try {
    const dir = projectDir(projectId);
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(dir, f));

    const sessions: SessionMeta[] = [];
    for (const f of files) {
      const meta = readMeta(f);
      if (meta) sessions.push(meta);
    }

    // Sort newest first
    sessions.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
    return sessions;
  } catch {
    return [];
  }
}

/**
 * Load messages from a specific session by ID.
 */
export function loadSessionById(projectId: string, sessionId: string): Message[] {
  if (!projectId || !sessionId) return [];
  const filePath = sessionFilePath(projectId, sessionId);
  try {
    if (!fs.existsSync(filePath)) return [];
    const lines = fs
      .readFileSync(filePath, 'utf8')
      .split('\n')
      .filter((l) => l.trim());
    const msgs: Message[] = [];
    for (const line of lines.slice(1)) {
      // skip meta line
      try {
        const { role, content } = JSON.parse(line);
        if (role === 'user' || role === 'assistant') msgs.push({ role, content });
      } catch {
        /* skip malformed */
      }
    }
    return msgs;
  } catch {
    return [];
  }
}

/**
 * Keep only the most recent MAX_SESSIONS session files for a project.
 */
export function pruneOldSessions(projectId: string): void {
  if (!projectId) return;
  try {
    const dir = projectDir(projectId);
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    for (const f of files.slice(MAX_SESSIONS)) {
      try {
        fs.unlinkSync(path.join(dir, f.name));
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

// ─── readline input history ───────────────────────────────────────────────────

export function loadInputHistory(): string[] {
  try {
    ensureDir(path.dirname(HISTORY_FILE));
    if (!fs.existsSync(HISTORY_FILE)) return [];
    return fs
      .readFileSync(HISTORY_FILE, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .reverse()
      .slice(0, 500);
  } catch {
    return [];
  }
}

export function appendInputHistory(line: string): void {
  if (!line.trim() || line.startsWith('!')) return;
  try {
    ensureDir(path.dirname(HISTORY_FILE));
    fs.appendFileSync(HISTORY_FILE, line + '\n', 'utf8');
    try {
      const content = fs.readFileSync(HISTORY_FILE, 'utf8');
      const lines = content.split('\n').filter((l) => l.trim());
      if (lines.length > 1000) {
        fs.writeFileSync(HISTORY_FILE, lines.slice(-1000).join('\n') + '\n', 'utf8');
      }
    } catch {
      /* ignore */
    }
  } catch {
    /* best-effort */
  }
}
