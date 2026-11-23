#!/usr/bin/env node
// Switchboard: a local web dashboard for the agents running in cmux.
//
// Reads cmux state through the cmux CLI (current, workspace.list, feed.list,
// notification.list, list-status, events) and Claude Code transcripts from
// ~/.claude/projects. Everything stays on this machine: the server listens on
// 127.0.0.1 only, and every write action goes through cmux itself.

import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { open, readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 4747;
const BUNDLED_CMUX = '/Applications/cmux.app/Contents/Resources/bin/cmux';
const CMUX = process.env.CMUX_BIN || (existsSync(BUNDLED_CMUX) ? BUNDLED_CMUX : 'cmux');
const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const TOKEN = crypto.randomBytes(24).toString('hex');

const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;
const ACTIVITY_WINDOW_MS = 3 * 60 * 60 * 1000;
const ACTIVITY_BINS = 36;
// cmux parks a Feed decision for at most ~120 s, then the agent falls back to its own prompt.
const FEED_DECISION_TTL_MS = 120 * 1000;
const PERIODIC_REFRESH_MS = 5000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map((h) => `http://${h}`));

// ---------------------------------------------------------------------------
// cmux bridge

function cmux(args, { input, timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(CMUX, args, { timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || stdout || err.message).trim().replace(/^Error:\s*/, '');
        reject(Object.assign(new Error(detail || err.message), { status: 502, expose: true }));
      } else {
        resolve(stdout);
      }
    });
    child.stdin.end(input ?? '');
  });
}

const cmuxJSON = async (args) => JSON.parse(await cmux(args));
const rpc = (method, params = {}) => cmuxJSON(['rpc', method, JSON.stringify(params)]);

// `cmux list-status` prints lines like:
//   claude_code=Running icon=bolt.fill color=#4C8DFF work=running
//   program_status=claude-code · Start the dev server icon=bolt.fill priority=2
function parseStatusLines(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const m = /^([\w.-]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    const rest = m[2];
    const attrAt = rest.search(/\s(?:icon|color|work|priority|url|format)=/);
    const value = (attrAt === -1 ? rest : rest.slice(0, attrAt)).trim();
    const attrs = {};
    if (attrAt !== -1) for (const a of rest.slice(attrAt).matchAll(/(\w+)=(\S+)/g)) attrs[a[1]] = a[2];
    out[m[1]] = { value, ...attrs };
  }
  return out;
}

// Feed workstream ids look like "cmux-feed-v1:<base64 agent>:<base64 session id>".
function sessionFromWorkstream(id) {
  const m = /^cmux-feed-v1:([^:]+):(.+)$/.exec(id || '');
  if (!m) return null;
  try {
    return Buffer.from(m[2], 'base64').toString('utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Claude Code transcripts

const transcriptPaths = new Map();
const transcriptCache = new Map();

async function locateTranscript(sessionId) {
  const known = transcriptPaths.get(sessionId);
  if (known && existsSync(known)) return known;
  let dirs = [];
  try {
    dirs = await readdir(CLAUDE_PROJECTS);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = path.join(CLAUDE_PROJECTS, dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) {
      transcriptPaths.set(sessionId, candidate);
      return candidate;
    }
  }
  return null;
}

async function readTranscript(sessionId) {
  if (!UUID_RE.test(sessionId || '')) return null;
  const file = await locateTranscript(sessionId);
  if (!file) return null;
  const st = await stat(file);
  const cached = transcriptCache.get(sessionId);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.data;

  const start = Math.max(0, st.size - TRANSCRIPT_TAIL_BYTES);
  const buf = Buffer.alloc(st.size - start);
  const fh = await open(file, 'r');
  try {
    await fh.read(buf, 0, buf.length, start);
  } finally {
    await fh.close();
  }
  let text = buf.toString('utf8');
  if (start > 0) text = text.slice(text.indexOf('\n') + 1);
  const data = summarizeTranscript(text.split('\n'));

  // Long agentic turns can push the last typed prompt out of the tail. Look further back once and remember it.
  if (data.lastUserText) {
    promptMemory.set(sessionId, { text: data.lastUserText, at: data.lastUserAt });
  } else {
    let remembered = promptMemory.get(sessionId);
    if (!remembered && start > 0) {
      remembered = (await scanBackForPrompt(file, start).catch(() => null)) || { text: null, at: null };
      promptMemory.set(sessionId, remembered);
    }
    if (remembered?.text) {
      data.lastPrompt = remembered.text;
      data.lastUserAt = remembered.at;
    }
  }

  transcriptCache.set(sessionId, { mtimeMs: st.mtimeMs, size: st.size, data });
  return data;
}

const promptMemory = new Map();

async function scanBackForPrompt(file, end) {
  const CHUNK = 4 * 1024 * 1024;
  const LIMIT = 96 * 1024 * 1024;
  const fh = await open(file, 'r');
  try {
    let pos = end;
    let carry = Buffer.alloc(0);
    while (pos > 0 && end - pos < LIMIT) {
      const start = Math.max(0, pos - CHUNK);
      const chunk = Buffer.alloc(pos - start);
      await fh.read(chunk, 0, chunk.length, start);
      let combined = Buffer.concat([chunk, carry]);
      if (start > 0) {
        // The first line may begin before this chunk; carry its bytes into the next read.
        const nl = combined.indexOf(0x0a);
        carry = nl === -1 ? combined : combined.subarray(0, nl);
        combined = nl === -1 ? Buffer.alloc(0) : combined.subarray(nl + 1);
      }
      const lines = combined.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (!lines[i].includes('"type":"user"')) continue;
        let r;
        try {
          r = JSON.parse(lines[i]);
        } catch {
          continue;
        }
        const prompt = humanPromptOf(r);
        if (prompt) return { text: prompt, at: r.timestamp };
      }
      pos = start;
    }
  } finally {
    await fh.close();
  }
  return null;
}

// The text a person typed in a transcript "user" entry, or null for tool results and injected context.
function humanPromptOf(r) {
  if (r.type !== 'user' || r.isSidechain || r.isMeta) return null;
  const content = r.message?.content;
  if (typeof content === 'string') return isHumanText(content) ? content : null;
  if (!Array.isArray(content)) return null;
  const texts = content.filter((b) => b.type === 'text' && isHumanText(b.text)).map((b) => b.text);
  return texts.length ? texts.join('\n') : null;
}

function isHumanText(text) {
  const t = String(text || '').trim();
  return t.length > 0 && !t.startsWith('<') && !t.startsWith('[Request interrupted');
}

function summarizeTranscript(lines) {
  const s = {
    title: null,
    customTitle: null,
    lastPrompt: null,
    lastUserAt: null,
    lastText: null,
    lastTextAt: null,
    lastAssistantAt: null,
    recap: null,
    recapAt: null,
    model: null,
    contextTokens: null,
    branch: null,
    cwd: null,
    mode: null,
  };
  const openTools = new Map();

  for (const line of lines) {
    if (!line) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    switch (r.type) {
      case 'ai-title':
        s.title = r.aiTitle || s.title;
        break;
      case 'custom-title':
        s.customTitle = r.customTitle || s.customTitle;
        break;
      case 'last-prompt':
        // Background-task notices and slash-command echoes also land here; keep only what a person typed.
        if (isHumanText(r.lastPrompt)) s.lastPrompt = r.lastPrompt;
        break;
      case 'system':
        if (r.subtype === 'away_summary' && r.content) {
          s.recap = String(r.content).replace(/\s*\(turn off recaps in \/config\)\s*$/i, '');
          s.recapAt = r.timestamp;
        }
        break;
      case 'user': {
        if (r.isSidechain) break;
        if (r.permissionMode) s.mode = r.permissionMode;
        const content = r.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) if (block.type === 'tool_result') openTools.delete(block.tool_use_id);
        }
        const promptText = humanPromptOf(r);
        if (promptText) {
          s.lastUserAt = r.timestamp;
          s.lastUserText = promptText;
        }
        break;
      }
      case 'assistant': {
        if (r.isSidechain) break;
        const m = r.message || {};
        const real = m.model && m.model !== '<synthetic>';
        if (real) s.model = m.model;
        const u = m.usage;
        if (real && u) {
          s.contextTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        }
        if (r.gitBranch) s.branch = r.gitBranch;
        if (r.cwd) s.cwd = r.cwd;
        s.lastAssistantAt = r.timestamp;
        for (const block of m.content || []) {
          if (block.type === 'text' && block.text?.trim()) {
            s.lastText = block.text;
            s.lastTextAt = r.timestamp;
          } else if (block.type === 'tool_use') {
            openTools.set(block.id, { name: block.name, input: block.input || {}, at: r.timestamp });
          }
        }
        break;
      }
      default:
        break;
    }
  }

  // Claude writes its last-prompt entry at the end of a turn; the message itself is there sooner.
  if (s.lastUserText) s.lastPrompt = s.lastUserText;

  // Tools from before the latest prompt that never got a result were interrupted; ignore them.
  const since = Date.parse(s.lastUserAt || 0) || 0;
  const live = [...openTools.values()].filter((t) => (Date.parse(t.at) || 0) >= since);
  const lastTool = live[live.length - 1] || null;
  s.currentTool = lastTool ? describeTool(lastTool.name, lastTool.input) : null;
  // Every open call, for pairing a permission request with the exact one it's about (pairTool).
  s.openTools = live.map((t) => ({ name: t.name, input: t.input, at: t.at }));
  s.pendingQuestion = lastTool?.name === 'AskUserQuestion' ? normalizeQuestions(lastTool.input?.questions) : null;
  s.pendingPlan = lastTool?.name === 'ExitPlanMode' ? clip(String(lastTool.input?.plan || ''), 6000) : null;
  return s;
}

function prettyToolName(name) {
  if (!name) return null;
  if (name.startsWith('mcp__')) {
    const [, server, ...rest] = name.split('__');
    return `${server.replace(/^claude_ai_/, '')} · ${rest.join('__')}`;
  }
  return name;
}

function describeTool(name, input = {}) {
  let detail = input.description || input.command || input.pattern || input.url || input.query || input.skill || input.prompt || '';
  if (!detail && (input.file_path || input.path || input.notebook_path)) {
    detail = path.basename(String(input.file_path || input.path || input.notebook_path));
  }
  detail = String(detail).replace(/\s+/g, ' ').trim();
  const command = typeof input.command === 'string' ? clip(input.command.trim(), 800) : null;
  return { name: prettyToolName(name), detail: clip(detail, 180), command };
}

function normalizeQuestions(questions) {
  if (!Array.isArray(questions)) return null;
  return questions.slice(0, 4).map((q) => ({
    header: q.header || null,
    question: q.question || '',
    multiSelect: Boolean(q.multiSelect ?? q.multi_select),
    options: (q.options || []).slice(0, 8).map((o) => ({ label: o.label || String(o), description: o.description || null })),
  }));
}

function clip(text, max) {
  const t = String(text ?? '');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// The final paragraph of a reply that ends with a question mark, trimmed to the question itself.
function trailingQuestion(text) {
  if (!text) return null;
  const paras = String(text).trim().split(/\n\s*\n/);
  const last = paras[paras.length - 1] || '';
  const plain = last.replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
  if (!/[?？]["”)]?$/.test(plain)) return null;
  const sentences = plain.split(/(?<=[.!?])\s+(?=[A-Z¿¡"“(])/);
  let q = sentences[sentences.length - 1];
  if (q.length < 30 && sentences.length > 1) q = sentences.slice(-2).join(' ');
  return q.length > 320 ? `…${q.slice(-319)}` : q;
}

function prettyModel(model) {
  if (!model) return null;
  return model.replace(/^claude-/, '').replace(/-(\d+)-(\d+)(?:-\d{8})?$/, ' $1.$2').replace(/-/g, ' ');
}

function normalizePorts(ports) {
  if (!Array.isArray(ports)) return [];
  return [...new Set(ports.map((p) => Number(typeof p === 'object' ? p?.port : p)).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
}

function latestIso(...values) {
  let best = null;
  for (const v of values) if (v && (!best || Date.parse(v) > Date.parse(best))) best = v;
  return best;
}

// ---------------------------------------------------------------------------
// Snapshot

function pickAgent(agents = []) {
  const byRecent = [...agents].sort((a, b) => (Date.parse(b.last_activity_at) || 0) - (Date.parse(a.last_activity_at) || 0));
  return { live: byRecent.find((a) => a.state !== 'ended') || null, ended: byRecent.find((a) => a.state === 'ended') || null };
}

function isOpenDecision(item, now) {
  if (!/permission|question|plan/i.test(item.kind || '')) return false;
  if (item.resolved_at) return false;
  if (['expired', 'telemetry', 'resolved', 'answered', 'completed', 'cancelled', 'timeout', 'timed_out'].includes(item.status)) return false;
  const created = Date.parse(item.created_at);
  return Number.isFinite(created) && now - created < FEED_DECISION_TTL_MS;
}

function parseLooseJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** How close (ms) a tool call must be to the permission request it's paired with. */
const PAIR_WINDOW_MS = 30_000;

/**
 * The transcript's copy of the tool call a permission request is about (the
 * Feed's copy has its paths redacted), only when it can't be another call:
 * exactly one open call of that tool, made within 30 s of the request.
 * Pairing by name alone could show one Bash command while Allow approved
 * another (two running in parallel), or an older call still running while the
 * new one hadn't reached the transcript yet. Otherwise null: the card shows the
 * Feed's copy, which is exactly what Allow approves.
 */
function pairTool(openTools, toolName, requestedAt) {
  const name = prettyToolName(toolName);
  const at = Date.parse(requestedAt);
  if (!name || !Number.isFinite(at)) return null;
  const near = (openTools || []).filter((t) => prettyToolName(t.name) === name && Math.abs((Date.parse(t.at) || 0) - at) <= PAIR_WINDOW_MS);
  return near.length === 1 ? describeTool(near[0].name, near[0].input) : null;
}

function describeDecision(feedItem, tx) {
  const kind = /question/i.test(feedItem.kind) ? 'question' : /plan/i.test(feedItem.kind) ? 'plan' : 'permission';
  const created = Date.parse(feedItem.created_at);
  const base = {
    kind,
    requestId: UUID_RE.test(feedItem.request_id || '') ? feedItem.request_id : null,
    since: feedItem.created_at,
    deadline: Number.isFinite(created) ? new Date(created + FEED_DECISION_TTL_MS).toISOString() : null,
  };
  if (kind === 'question') {
    return { ...base, questions: tx?.pendingQuestion || [{ header: null, question: feedItem.question_prompt || feedItem.title || 'Question', multiSelect: Boolean(feedItem.question_multi_select), options: [] }] };
  }
  if (kind === 'plan') return { ...base, plan: tx?.pendingPlan || null };
  // The transcript's copy of the exact call (the Feed copy has paths redacted), when it's certain.
  const toolName = feedItem.tool_name || feedItem.title;
  const fromTx = pairTool(tx?.openTools, toolName, feedItem.created_at);
  return { ...base, tool: fromTx || describeTool(toolName, parseLooseJSON(feedItem.tool_input) || {}) };
}

async function buildSnapshot() {
  const now = Date.now();
  const [current, wsList, feed, notes] = await Promise.all([
    cmuxJSON(['current', '--json', '--limit', '200']),
    rpc('workspace.list').catch(() => ({ workspaces: [] })),
    rpc('feed.list').catch(() => ({ items: [] })),
    rpc('notification.list').catch(() => ({ notifications: [] })),
  ]);

  const workspaces = new Map((wsList.workspaces || []).map((w) => [w.id, w]));
  const terminals = (current.items || []).filter((it) => it.kind === 'terminal' && it.projections?.[0]?.panel_id);
  const wsIds = [...new Set(terminals.map((t) => t.projections[0].workspace_id).filter(Boolean))];
  const statuses = new Map(
    await Promise.all(wsIds.map(async (id) => [id, parseStatusLines(await cmux(['list-status', '--workspace', id]).catch(() => ''))])),
  );

  // Feed: open decisions, activity histogram, last stop message per session.
  const windowStart = now - ACTIVITY_WINDOW_MS;
  const binMs = ACTIVITY_WINDOW_MS / ACTIVITY_BINS;
  const pulse = new Array(ACTIVITY_BINS).fill(0);
  const activity = new Map();
  const decisions = new Map();
  const lastStop = new Map();
  for (const it of feed.items || []) {
    const sessionId = sessionFromWorkstream(it.workstream_id);
    if (!sessionId) continue;
    const t = Date.parse(it.created_at);
    if (it.kind === 'toolUse' && t >= windowStart && t <= now) {
      const bin = Math.min(ACTIVITY_BINS - 1, Math.floor((t - windowStart) / binMs));
      if (!activity.has(sessionId)) activity.set(sessionId, new Array(ACTIVITY_BINS).fill(0));
      activity.get(sessionId)[bin] += 1;
      pulse[bin] += 1;
    } else if (it.kind === 'stop' && it.reason) {
      lastStop.set(sessionId, { text: it.reason, at: it.created_at });
    }
    if (isOpenDecision(it, now)) decisions.set(sessionId, it);
  }

  const unread = new Map();
  for (const n of notes.notifications || []) {
    if (n.is_read || !n.surface_id) continue;
    unread.set(n.surface_id, (unread.get(n.surface_id) || 0) + 1);
  }

  const items = await Promise.all(
    terminals.map(async (t) => {
      const proj = t.projections[0];
      const ws = workspaces.get(proj.workspace_id) || {};
      const { live: agent, ended } = pickAgent(t.agents);
      const st = statuses.get(proj.workspace_id) || {};
      const agentStatus = st.claude_code || st.codex || Object.values(st).find((v) => v.work) || null;
      let programStatus = st.program_status?.value?.replace(/^[\w-]+\s*·\s*/, '') || null;
      if (/^(working|running|idle|waiting|thinking)$/i.test(programStatus || '')) programStatus = null;
      const tx = agent?.kind === 'claude' ? await readTranscript(agent.session_id).catch(() => null) : null;
      const feedDecision = agent ? decisions.get(agent.session_id) : null;

      let phase = 'shell';
      let blocked = null;
      if (agent) {
        if (feedDecision) {
          phase = 'blocked';
          blocked = describeDecision(feedDecision, tx);
        } else if (tx?.pendingQuestion) {
          phase = 'blocked';
          blocked = { kind: 'question', requestId: null, since: tx.lastAssistantAt, questions: tx.pendingQuestion };
        } else if (tx?.pendingPlan) {
          phase = 'blocked';
          blocked = { kind: 'plan', requestId: null, since: tx.lastAssistantAt, plan: tx.pendingPlan };
        } else if (/permission|needs input|approval/i.test(agentStatus?.value || '')) {
          phase = 'blocked';
          blocked = { kind: 'terminal', requestId: null, since: agent.last_activity_at, label: agentStatus.value, tool: tx?.currentTool || null };
        } else if (agent.state === 'working' || agentStatus?.work === 'running') {
          phase = 'working';
        } else {
          phase = 'idle';
        }
      }

      // The transcript knows which prompts a person typed; cmux's workspace copy also counts
      // injected ones (background-task notices), so it is only the fallback.
      const wsPrompt = isHumanText(ws.latest_submitted_message) ? ws.latest_submitted_message : null;
      const lastPromptAt = tx?.lastUserAt || (wsPrompt ? ws.latest_submitted_at : null) || null;
      const lastPrompt = tx?.lastUserAt ? tx.lastPrompt : wsPrompt;
      const reply = tx?.lastText ? { text: clip(tx.lastText, 24000), at: tx.lastTextAt } : agent ? lastStop.get(agent.session_id) || null : null;
      const replyIsCurrent = reply && (!lastPromptAt || Date.parse(reply.at) >= Date.parse(lastPromptAt));
      const recapIsCurrent = tx?.recap && (!lastPromptAt || Date.parse(tx.recapAt) >= Date.parse(lastPromptAt));
      const cwd = tx?.cwd || t.cwd || ws.current_directory || null;

      return {
        surfaceId: proj.panel_id,
        workspaceId: proj.workspace_id,
        workspaceRef: ws.ref || null,
        order: Number.isInteger(ws.index) ? ws.index : 999,
        title: ws.title || t.label || 'Terminal',
        subtitle: t.label && ws.title && t.label !== ws.title ? t.label : null,
        here: Boolean(ws.selected),
        cwd,
        project: cwd ? path.basename(cwd) : null,
        branch: tx?.branch && tx.branch !== 'HEAD' ? tx.branch : null,
        ports: normalizePorts(ws.listening_ports),
        agent: agent ? { kind: agent.kind, sessionId: agent.session_id, state: agent.state } : null,
        phase,
        blocked,
        statusLabel: agentStatus?.value || null,
        model: prettyModel(tx?.model),
        mode: tx?.mode || null,
        contextTokens: tx?.contextTokens ?? null,
        lastPrompt: lastPrompt ? clip(lastPrompt, 600) : null,
        lastPromptAt,
        reply: replyIsCurrent ? reply : null,
        recap: recapIsCurrent ? { text: tx.recap, at: tx.recapAt } : null,
        question: phase === 'idle' && replyIsCurrent ? trailingQuestion(reply.text) : null,
        now: phase === 'working' ? tx?.currentTool || (programStatus ? { name: null, detail: programStatus } : null) : null,
        turnStartedAt: phase === 'working' ? lastPromptAt : null,
        // cmux bumps last_activity_at when it restores sessions after a restart, so a
        // transcript's own timestamps are the better signal for "when did work last happen".
        lastActivityAt:
          tx?.lastAssistantAt || tx?.lastUserAt
            ? latestIso(tx.lastAssistantAt, tx.lastUserAt, phase === 'working' || phase === 'blocked' ? agent?.last_activity_at : null)
            : latestIso(agent?.last_activity_at, ended?.last_activity_at),
        unread: unread.get(proj.panel_id) || 0,
        activity: agent ? activity.get(agent.session_id) || null : null,
      };
    }),
  );

  return {
    generatedAt: new Date(now).toISOString(),
    cmux: { ok: true },
    items,
    pulse: { start: new Date(windowStart).toISOString(), binMs, bins: pulse },
  };
}

// ---------------------------------------------------------------------------
// Refresh loop and live events

let snapshot = null;
let lastPayload = '';
let refreshing = false;
let dirty = false;
let refreshTimer = null;
let firstScheduledAt = 0;
let eventsLive = false;
const clients = new Set();

function scheduleRefresh(delay = 250) {
  const now = Date.now();
  if (!refreshTimer) firstScheduledAt = now;
  clearTimeout(refreshTimer);
  const wait = Math.max(0, Math.min(delay, firstScheduledAt + 1000 - now));
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refresh();
  }, wait);
}

async function refresh() {
  if (refreshing) {
    dirty = true;
    return;
  }
  refreshing = true;
  try {
    snapshot = await buildSnapshot();
  } catch (err) {
    snapshot = {
      ...(snapshot || { items: [], pulse: null }),
      generatedAt: new Date().toISOString(),
      cmux: { ok: false, error: String(err.message || err) },
    };
  } finally {
    refreshing = false;
  }
  publish();
  if (dirty) {
    dirty = false;
    scheduleRefresh();
  }
}

function currentPayload() {
  return { ...snapshot, cmux: { ...snapshot.cmux, eventsLive } };
}

function publish(force = false) {
  if (!snapshot) return;
  const { generatedAt, ...comparable } = currentPayload();
  const key = JSON.stringify(comparable);
  if (!force && key === lastPayload) return;
  lastPayload = key;
  broadcast('snapshot', currentPayload());
}

function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(frame);
}

const seenHookRequests = new Map();

function onEvent(e) {
  if (e.type !== 'event') return;
  const name = e.name || '';
  if (name.startsWith('agent.hook.')) {
    const p = e.payload || {};
    const requestKey = p._opencode_request_id || e.id;
    if (!seenHookRequests.has(requestKey)) {
      seenHookRequests.set(requestKey, Date.now());
      const surfaceId = p.surface_id || e.surface_id;
      if (surfaceId) broadcast('tick', { surfaceId, hook: p.hook_event_name || name.slice('agent.hook.'.length) });
    }
    if (seenHookRequests.size > 2000) {
      const cutoff = Date.now() - 60000;
      for (const [k, t] of seenHookRequests) if (t < cutoff) seenHookRequests.delete(k);
    }
  }
  if (['agent', 'feed', 'notification', 'workspace', 'sidebar', 'terminal', 'surface'].includes(e.category)) scheduleRefresh();
}

function startEvents() {
  const child = spawn(CMUX, ['events', '--reconnect', '--no-heartbeat', '--no-ack'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    if (!eventsLive) {
      eventsLive = true;
      publish(true);
    }
    try {
      onEvent(JSON.parse(line));
    } catch {
      // Ignore malformed frames.
    }
  });
  child.on('error', () => {});
  child.on('exit', () => {
    eventsLive = false;
    publish(true);
    setTimeout(startEvents, 3000);
  });
}

// ---------------------------------------------------------------------------
// Actions

function fail(status, message) {
  return Object.assign(new Error(message), { status, expose: true });
}

function requireUuid(value, label) {
  if (!UUID_RE.test(String(value || ''))) throw fail(400, `Invalid ${label}`);
  return value;
}

async function handleAction(body) {
  switch (body.action) {
    case 'jump': {
      const ws = requireUuid(body.workspaceId, 'workspace');
      const surface = requireUuid(body.surfaceId, 'surface');
      await cmux(['select-workspace', '--workspace', ws]);
      await cmux(['focus-panel', '--panel', surface, '--workspace', ws]).catch(() => {});
      await new Promise((resolve) => execFile('open', ['-a', 'cmux'], () => resolve()));
      return { ok: true };
    }
    case 'reply': {
      const ws = requireUuid(body.workspaceId, 'workspace');
      const surface = requireUuid(body.surfaceId, 'surface');
      const text = String(body.text ?? '').replace(/\r\n?/g, '\n').trim();
      if (!text) throw fail(400, 'Write a reply first.');
      if (text.length > 8000) throw fail(400, 'That reply is too long for a quick reply. Open the terminal instead.');
      if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) throw fail(400, 'The reply contains control characters.');
      // Re-check against live state: only type into an idle agent whose prompt box is empty.
      const fresh = await buildSnapshot();
      const item = fresh.items.find((i) => i.surfaceId === surface);
      if (!item?.agent) throw fail(409, 'There is no agent running in that terminal.');
      if (item.phase !== 'idle') throw fail(409, `The agent is ${item.phase === 'blocked' ? 'waiting on a decision' : 'working'} right now. Open it in cmux instead.`);
      const input = await rpc('surface.input_state', { surface_id: surface });
      if (!input.agent || input.blocks_typing || input.state !== 'empty') {
        throw fail(409, 'The prompt box in that terminal is not empty. Open it in cmux so your draft is not mixed in.');
      }
      await cmux(['paste', '--workspace', ws, '--surface', surface, '--submit', '-'], { input: text });
      scheduleRefresh(100);
      return { ok: true };
    }
    case 'permission': {
      const requestId = requireUuid(body.requestId, 'request');
      if (!['once', 'always', 'deny'].includes(body.mode)) throw fail(400, 'Unknown permission choice');
      await rpc('feed.permission.reply', { request_id: requestId, mode: body.mode });
      scheduleRefresh(100);
      return { ok: true };
    }
    case 'plan': {
      const requestId = requireUuid(body.requestId, 'request');
      if (!['manual', 'autoAccept', 'deny'].includes(body.mode)) throw fail(400, 'Unknown plan choice');
      await rpc('feed.exit_plan.reply', { request_id: requestId, mode: body.mode });
      scheduleRefresh(100);
      return { ok: true };
    }
    case 'question': {
      const requestId = requireUuid(body.requestId, 'request');
      const selections = Array.isArray(body.selections) ? body.selections.map((s) => String(s).slice(0, 500)).slice(0, 16) : [];
      if (!selections.length) throw fail(400, 'Pick an answer first.');
      await rpc('feed.question.reply', { request_id: requestId, selections });
      scheduleRefresh(100);
      return { ok: true };
    }
    case 'markRead': {
      const ws = requireUuid(body.workspaceId, 'workspace');
      await cmux(['mark-notification-read', '--workspace', ws]);
      scheduleRefresh(100);
      return { ok: true };
    }
    default:
      throw fail(400, 'Unknown action');
  }
}

// ---------------------------------------------------------------------------
// HTTP

const STATIC = {
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  // No other page may frame this one: a hidden frame under a fake button could steal a click on
  // "Allow" (clickjacking). frame-ancestors for current browsers, X-Frame-Options for older ones.
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

/** The token, compared in constant time. */
function tokenOk(value) {
  if (typeof value !== 'string' || value.length !== TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(value), Buffer.from(TOKEN));
}

function send(res, status, type, body, extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...extra });
  res.end(body);
}

const sendJSON = (res, status, data) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(data));

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(fail(413, 'Request too large'));
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    // Reject anything not addressed to this machine by name (blocks DNS rebinding).
    if (!ALLOWED_HOSTS.has(req.headers.host || '')) return send(res, 421, 'text/plain', 'Misdirected request');
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/') {
      const html = (await readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8')).replace('__SWITCHBOARD_TOKEN__', TOKEN);
      return send(res, 200, 'text/html; charset=utf-8', html);
    }

    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      return send(res, 200, type, await readFile(path.join(PUBLIC_DIR, file)));
    }

    if (req.method === 'GET' && url.pathname === '/api/stream') {
      if (!tokenOk(url.searchParams.get('token'))) return send(res, 403, 'text/plain', 'Forbidden');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', ...SECURITY_HEADERS });
      res.write('retry: 2000\n\n');
      clients.add(res);
      if (snapshot) res.write(`event: snapshot\ndata: ${JSON.stringify(currentPayload())}\n\n`);
      const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 20000);
      req.on('close', () => {
        clearInterval(keepAlive);
        clients.delete(res);
      });
      return;
    }

    if (url.pathname === '/api/snapshot' && req.method === 'GET') {
      if (!tokenOk(req.headers['x-switchboard-token'])) return sendJSON(res, 403, { error: 'Forbidden' });
      return sendJSON(res, 200, snapshot ? currentPayload() : await buildSnapshot());
    }

    if (url.pathname === '/api/action' && req.method === 'POST') {
      const origin = req.headers.origin;
      if (origin && !ALLOWED_ORIGINS.has(origin)) return sendJSON(res, 403, { error: 'Forbidden origin' });
      if (!tokenOk(req.headers['x-switchboard-token'])) return sendJSON(res, 403, { error: 'Forbidden' });
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return sendJSON(res, 415, { error: 'Send JSON' });
      const body = parseLooseJSON(await readBody(req));
      if (!body || typeof body !== 'object') return sendJSON(res, 400, { error: 'Invalid JSON' });
      return sendJSON(res, 200, await handleAction(body));
    }

    return send(res, 404, 'text/plain', 'Not found');
  } catch (err) {
    if (!res.headersSent) sendJSON(res, err.status || 500, { error: err.expose ? err.message : 'Something went wrong on the Switchboard server.' });
    if (!err.expose) console.error(err);
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Start with PORT=<other> npm start.`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  console.log(`Switchboard is running at http://localhost:${PORT}`);
  if (!process.env.CMUX_SOCKET && !process.env.CMUX_SOCKET_PATH && !process.env.CMUX_PANEL_ID) {
    console.log('Note: this shell does not look like a cmux terminal. If cmux refuses the connection, start Switchboard from a cmux terminal.');
  }
  refresh();
  startEvents();
  setInterval(() => scheduleRefresh(0), PERIODIC_REFRESH_MS);
});
