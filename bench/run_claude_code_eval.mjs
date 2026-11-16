#!/usr/bin/env node
// Head-to-head: Claude Code's experimental Code Mode vs tool-prune schema pruning,
// measured inside real Claude Code sessions on the 60-tool / 79-query catalog.
//
// Arms (same model, same queries, same stub MCP server, same appended instruction):
//   default            Claude Code as shipped: 60 catalog tools deferred behind ToolSearch
//   upfront            ENABLE_TOOL_SEARCH=false: all 60 catalog schemas sent in the prompt
//   toolprune-upfront  ENABLE_TOOL_SEARCH=false + catalog pruned per query to TurboQuant Top-5
//   toolprune          default (deferred) + catalog pruned per query to TurboQuant Top-5
//   codemode           CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1, all 60 catalog tools
//   codemode+toolprune Code Mode on top of the pruned catalog
//   jev-upfront        ENABLE_TOOL_SEARCH=false + catalog pruned to TypeSafe Jev Top-3
//   jev                default (deferred) + catalog pruned to TypeSafe Jev Top-3
//   jev-direct         (derived, no extra sessions) dispatch Jev's choice when its
//                      confidence >= 0.85, otherwise fall back to the `jev` session
// The jev arms need TYPESAFE_API_KEY; retrieval is cached in <run-dir>/jev-retrieval.json.
//
// Code Mode only starts in the interactive terminal, so every arm is driven through
// a pty (bench/pty_session.py) and scored from the session transcript plus the stub
// server's call log (bench/mcp_catalog_server.mjs).
//
// One-time setup (see bench/CODE_MODE_VS_TOOL_PRUNE.md):
//   export CC_BENCH_CONFIG_DIR=/tmp/cmbench/cfg   # isolated CLAUDE_CONFIG_DIR
//   - start `claude` once there to finish onboarding and trust CC_BENCH_WORKDIR
//   - start it once with CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1 and accept the opt-in
//
// Run:
//   node bench/run_claude_code_eval.mjs --model claude-sonnet-5-5 [--arms a,b] [--limit N]
//
// --dataset bfcl swaps in the 443-tool Gorilla BFCL_v3_multiple pool with its real
// parameter schemas and 200 queries. There the prompt is typed into the running
// session (after the MCP server has connected) instead of passed on the command line.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TOOLS_60 } from './catalog.mjs';
import { CASES_60 } from './cases.mjs';
import { TurboQuantSearch } from './turboquant.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const opt = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);

const MODEL = opt('--model', 'claude-sonnet-5-5');
const ARMS = opt('--arms', 'default,upfront,toolprune-upfront,toolprune,codemode,codemode+toolprune').split(',').map(s => s.trim()).filter(Boolean);
const LIMIT = Number(opt('--limit', '0'));
const CONCURRENCY = Number(opt('--concurrency', '4'));
const TIMEOUT_S = Number(opt('--timeout', '150'));
const PRUNE_K = Number(opt('--k', '5'));
const CONFIG_DIR = opt('--config-dir', process.env.CC_BENCH_CONFIG_DIR || '/tmp/cmbench/cfg');
const WORKDIR = fs.realpathSync(opt('--workdir', process.env.CC_BENCH_WORKDIR || '/tmp/cmbench/work'));
const RUN_DIR = opt('--run-dir', '/tmp/cmbench/runs');
const DATASET = opt('--dataset', 'catalog60');
const TAG = DATASET === 'catalog60' ? '' : `${DATASET}-`;
const OUT = path.resolve(
  __dirname,
  opt('--out', DATASET === 'catalog60' ? 'claude_code_codemode_results.json' : `claude_code_${DATASET}_results.json`)
);
const RAW = path.join(RUN_DIR, `raw-${TAG}${MODEL}.jsonl`);
// 'arg' passes the query on the command line; 'keys' types it once the session is up.
const PROMPT_VIA = opt('--prompt-via', DATASET === 'catalog60' ? 'arg' : 'keys');
const PROMPT_DELAY_S = Number(opt('--prompt-delay', '7'));

const SERVER = path.resolve(__dirname, 'mcp_catalog_server.mjs');
const PTY = path.resolve(__dirname, 'pty_session.py');
const PROJECT_DIR = path.join(CONFIG_DIR, 'projects', WORKDIR.replace(/[^a-zA-Z0-9]/g, '-'));

// Identical for every arm. Without it the agent answers "git status"-style requests
// with its own Bash tool and never touches the catalog, which measures nothing.
const INSTRUCTION = [
  'You are being evaluated on tool routing.',
  'The `catalog` MCP server exposes stub operations that have no real side effects.',
  'Handle each request by calling the single most appropriate catalog operation, then report briefly.',
  'Use only catalog operations for the request itself: never use shell, file, web, or agent tools.',
  'If the request is general conversation or a question that needs no operation, answer directly without calling any operation.'
].join(' ');

// Unanswered permission prompts block everything except the stub catalog.
const SETTINGS = JSON.stringify({ permissions: { allow: ['mcp__catalog'] } });

const BUILTIN_DOMAINS = new Set(opt('--builtin-domains', 'filesystem,code,git,web,process,system').split(','));

fs.mkdirSync(RUN_DIR, { recursive: true });

// MCP tool names allow only [a-zA-Z0-9_-]; BFCL names contain dots.
function toJsonSchema(node) {
  if (Array.isArray(node)) return node.map(toJsonSchema);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'optional') continue;
    out[k] = k === 'properties' ? Object.fromEntries(Object.entries(v).map(([n, d]) => [n, toJsonSchema(d)])) : toJsonSchema(v);
  }
  const map = { dict: 'object', float: 'number', tuple: 'array' };
  if (typeof out.type === 'string') {
    if (out.type === 'any') delete out.type;
    else if (map[out.type]) out.type = map[out.type];
  }
  return out;
}

function loadBfcl() {
  const read = f =>
    fs.readFileSync(path.resolve(__dirname, 'bfcl_dataset', f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const questions = read('BFCL_v3_multiple.json');
  const answers = new Map(read('BFCL_v3_multiple_answers.json').map(a => [a.id, (a.ground_truth || []).map(g => Object.keys(g)[0])]));
  // Same pool construction as bench/run_bfcl_eval.mjs (descriptions merged when a name recurs).
  const pool = new Map();
  for (const q of questions) {
    for (const fn of q.function) {
      const criteria = `${fn.description || ''} ${Object.keys(fn.parameters?.properties || {}).join(' ')}`.trim();
      const seen = pool.get(fn.name);
      if (!seen) pool.set(fn.name, { description: fn.description || fn.name, criteria, parameters: fn.parameters });
      else if (fn.description && !seen.description.includes(fn.description)) {
        seen.description = `${seen.description} ${fn.description}`.trim();
        seen.criteria = `${seen.criteria} ${criteria}`.trim();
      }
    }
  }
  const safe = new Map();
  const used = new Set();
  for (const name of pool.keys()) {
    let s = name.replace(/[^a-zA-Z0-9_-]/g, '_');
    while (used.has(s)) s += '_x';
    used.add(s);
    safe.set(name, s);
  }
  const tools = {};
  const defs = [];
  for (const [name, t] of pool) {
    const s = safe.get(name);
    tools[s] = { name: s, description: t.description, criteria: t.criteria, parameters: t.parameters, domain: 'bfcl' };
    defs.push({ name: s, description: t.description, inputSchema: { type: 'object', properties: {}, ...toJsonSchema(t.parameters || {}) } });
  }
  const cases = [];
  for (const q of questions) {
    const targets = answers.get(q.id) || [];
    if (targets.length === 1 && q.function.length >= 2) {
      cases.push({ query: q.question[0][0].content.replace(/\s+/g, ' ').trim(), target: safe.get(targets[0]), type: 'bfcl' });
    }
  }
  const catalogFile = path.join(RUN_DIR, 'bfcl-catalog.json');
  fs.writeFileSync(catalogFile, JSON.stringify(defs));
  return { tools, cases, catalogFile };
}

const DATA = DATASET === 'bfcl' ? loadBfcl() : { tools: TOOLS_60, cases: CASES_60, catalogFile: '' };
const TOOLS = DATA.tools;

const tq = new TurboQuantSearch();
tq.index(TOOLS);

const TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY;
const JEV_K = Number(opt('--jev-k', '3'));
const JEV_FAST_PATH = Number(opt('--jev-threshold', '0.85'));
const JEV_CACHE_FILE = `jev-retrieval${DATASET === 'catalog60' ? '' : '-' + DATASET}.json`;
// System One takes at most 255 choices; larger catalogs go TurboQuant Top-200 -> Jev,
// the same two-stage route bench/run_bfcl_eval.mjs uses.
const JEV_MAX_CHOICES = 200;
function jevCriteriaFor(query) {
  const names = Object.keys(TOOLS).length > 255 ? tq.search(query, JEV_MAX_CHOICES).map(r => r.name) : Object.keys(TOOLS);
  return Object.fromEntries(names.map(n => [n, TOOLS[n].criteria]));
}
let jevCache = {};
const JEV_CACHE = path.join(RUN_DIR, JEV_CACHE_FILE);

// Same System One request as bench/run.mjs, so the pruned sets match the README arm.
async function jevRetrieve(query) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const t0 = performance.now();
    try {
      const resp = await fetch('https://api.typesafe.ai/v1/systemone', {
        method: 'POST',
        headers: { Authorization: `Bearer ${TYPESAFE_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'jev-latest',
          state: { user_intent: query },
          questions: {
            tool: {
              type: 'choice',
              instructions: 'Which specific tool is required to satisfy this intent?',
              criteria: jevCriteriaFor(query)
            }
          }
        })
      });
      const latencyMs = performance.now() - t0;
      if (resp.status === 429 || resp.status >= 500) {
        await new Promise(r => setTimeout(r, 400 * 2 ** attempt));
        continue;
      }
      if (!resp.ok) throw new Error(`TypeSafe API returned HTTP ${resp.status}`);
      const answer = (await resp.json()).answers?.tool || {};
      const ranked = Object.entries(answer.probabilities || {}).sort((a, b) => b[1] - a[1]).map(p => p[0]);
      if (!ranked.length) throw new Error('TypeSafe API returned no probabilities');
      return { choice: answer.choice, confidence: answer.confidence || 0, ranked, latencyMs: Math.round(latencyMs) };
    } catch (err) {
      if (attempt === 4 || /HTTP 4/.test(String(err))) throw err;
      await new Promise(r => setTimeout(r, 400 * 2 ** attempt));
    }
  }
  throw new Error('TypeSafe API kept returning 429/5xx');
}

async function loadJevRetrieval(cases) {
  if (fs.existsSync(JEV_CACHE)) jevCache = JSON.parse(fs.readFileSync(JEV_CACHE, 'utf8'));
  const missing = cases.filter(c => !jevCache[c.query]);
  if (missing.length) {
    if (!TYPESAFE_API_KEY) throw new Error('The jev arms need TYPESAFE_API_KEY in the environment.');
    await pMap(missing, async c => { jevCache[c.query] = await jevRetrieve(c.query); }, 5);
    fs.writeFileSync(JEV_CACHE, JSON.stringify(jevCache, null, 2));
  }
}

function percentile(values, p = 50) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function bootstrapCI(bools, B = 1000, seed = 42) {
  let s = seed;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const n = bools.length;
  const accs = [];
  for (let b = 0; b < B; b++) {
    let hits = 0;
    for (let i = 0; i < n; i++) hits += bools[Math.floor(rand() * n)] ? 1 : 0;
    accs.push((hits / n) * 100);
  }
  return [Number(percentile(accs, 2.5).toFixed(1)), Number(percentile(accs, 97.5).toFixed(1))];
}

function runSession({ sessionId, env, args, transcript, screen, keys }) {
  return new Promise(resolve => {
    const child = spawn(
      'python3',
      [PTY, '--done-file', transcript, '--timeout', String(TIMEOUT_S), '--screen', screen, '--keys', JSON.stringify(keys || []), '--', 'claude', ...args],
      { cwd: WORKDIR, env, stdio: 'ignore' }
    );
    child.on('exit', code => resolve(code));
    child.on('error', () => resolve(-1));
  });
}

function parseTranscript(file) {
  const out = {
    replMode: false,
    requests: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    firstRequestPromptTokens: 0,
    turnMs: null,
    costUsd: null,
    topLevelTools: [],
    replScripts: [],
    searchQueries: [],
    finished: false
  };
  if (!fs.existsSync(file)) return out;
  const seenMsg = new Set();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.type === 'repl-mode') out.replMode = Boolean(d.replMode);
    if (d.type === 'system' && d.subtype === 'turn_duration') {
      out.turnMs = d.durationMs;
      out.finished = true;
    }
    if (d.type === 'cost-state') out.costUsd = d.modelUsage?.[MODEL]?.costUSD ?? d.totalCostUSD ?? null;
    if (d.type !== 'assistant' || d.isSidechain) continue;
    const msg = d.message || {};
    const isApiMessage = typeof msg.id === 'string' && msg.id.startsWith('msg_');
    for (const block of msg.content || []) {
      if (block.type !== 'tool_use') continue;
      if (isApiMessage) {
        out.topLevelTools.push(block.name);
        if (block.name === 'REPL') out.replScripts.push(block.input?.code || '');
      } else if (block.name === 'searchTools') {
        out.searchQueries.push(block.input?.query || '');
      }
    }
    if (!isApiMessage || seenMsg.has(msg.id)) continue;
    seenMsg.add(msg.id);
    const u = msg.usage || {};
    const prompt = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    out.requests += 1;
    out.inputTokens += u.input_tokens || 0;
    out.cacheReadTokens += u.cache_read_input_tokens || 0;
    out.cacheWriteTokens += u.cache_creation_input_tokens || 0;
    out.outputTokens += u.output_tokens || 0;
    if (out.requests === 1) out.firstRequestPromptTokens = prompt;
  }
  return out;
}

function readCalls(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l).tool);
}

async function runCase(arm, test, idx) {
  const codeMode = arm.includes('codemode');
  const jev = arm.includes('jev');
  const pruned = arm.includes('toolprune') || jev;
  const upfront = arm.includes('upfront');
  const sessionId = randomUUID();
  const base = path.join(RUN_DIR, `${TAG}${MODEL}-${arm}-${idx}`);
  const callLog = `${base}.calls.jsonl`;
  const mcpFile = `${base}.mcp.json`;
  const screen = `${base}.screen.txt`;
  const transcript = path.join(PROJECT_DIR, `${sessionId}.jsonl`);
  fs.rmSync(callLog, { force: true });

  let exposed = Object.keys(TOOLS);
  let pruneMs = 0;
  if (pruned) {
    const t0 = performance.now();
    if (jev) {
      exposed = jevCache[test.query].ranked.slice(0, JEV_K);
      pruneMs = jevCache[test.query].latencyMs;
    } else {
      exposed = tq.search(test.query, PRUNE_K).map(r => r.name);
      pruneMs = performance.now() - t0;
    }
  }

  fs.writeFileSync(
    mcpFile,
    JSON.stringify({
      mcpServers: {
        catalog: {
          command: 'node',
          args: [SERVER],
          env: {
            CATALOG_CALL_LOG: callLog,
            ...(DATA.catalogFile ? { CATALOG_FILE: DATA.catalogFile } : {}),
            ...(pruned ? { CATALOG_TOOLS: exposed.join(',') } : {})
          }
        }
      }
    })
  );

  // Start from a clean environment so a parent Claude Code session cannot leak in.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE')));
  env.CLAUDE_CONFIG_DIR = CONFIG_DIR;
  delete env.ENABLE_TOOL_SEARCH;
  if (codeMode) env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE = '1';
  if (upfront) env.ENABLE_TOOL_SEARCH = 'false';

  const args = [
    '--model', MODEL,
    '--session-id', sessionId,
    '--strict-mcp-config',
    '--mcp-config', mcpFile,
    '--permission-mode', 'manual',
    '--settings', SETTINGS,
    '--append-system-prompt', INSTRUCTION,
    ...(PROMPT_VIA === 'arg' ? [test.query] : [])
  ];
  const keys = PROMPT_VIA === 'arg' ? [] : [[PROMPT_DELAY_S, test.query], [PROMPT_DELAY_S + 0.8, '\r']];

  const t0 = Date.now();
  const exit = await runSession({ sessionId, env, args, transcript, screen, keys });
  const wallMs = Date.now() - t0;

  const tr = parseTranscript(transcript);
  const calls = readCalls(callLog);
  const real = calls.filter(c => c !== 'unsupported_or_none');
  const ood = test.type === 'ood';
  const hit = ood ? real.length === 0 : calls.includes(test.target);
  const exact = ood ? real.length === 0 : calls.length === 1 && calls[0] === test.target;

  return {
    arm,
    idx,
    query: test.query,
    target: test.target,
    type: test.type,
    domain: ood ? 'none' : TOOLS[test.target].domain,
    exit,
    finished: tr.finished,
    modeActive: tr.replMode,
    modeOk: tr.replMode === codeMode,
    exposedCount: exposed.length,
    targetExposed: ood ? null : exposed.includes(test.target),
    pruneMs: Number(pruneMs.toFixed(3)),
    calls,
    hit,
    exact,
    requests: tr.requests,
    promptTokens: tr.inputTokens + tr.cacheReadTokens + tr.cacheWriteTokens,
    cacheReadTokens: tr.cacheReadTokens,
    cacheWriteTokens: tr.cacheWriteTokens,
    firstRequestPromptTokens: tr.firstRequestPromptTokens,
    outputTokens: tr.outputTokens,
    turnMs: tr.turnMs,
    wallMs,
    costUsd: tr.costUsd,
    topLevelTools: tr.topLevelTools,
    replEvals: tr.replScripts.length,
    searchQueries: tr.searchQueries,
    usedToolSearch: tr.topLevelTools.includes('ToolSearch'),
    sessionId
  };
}

async function pMap(items, fn, concurrency) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    new Array(Math.min(concurrency, items.length)).fill(null).map(async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    })
  );
  return results;
}

function summarize(rows) {
  const n = rows.length;
  const pct = k => Number(((rows.filter(k).length / n) * 100).toFixed(1));
  const mean = k => rows.reduce((a, r) => a + (k(r) || 0), 0) / n;
  const hitRate = sub => (sub.length ? Number(((sub.filter(r => r.hit).length / sub.length) * 100).toFixed(1)) : null);
  const slice = t => hitRate(rows.filter(r => r.type === t));
  // Catalog domains that Claude Code already covers with built-in tools (Read, Bash, Grep, WebFetch...).
  const overlapsBuiltins = r => BUILTIN_DOMAINS.has(r.domain);
  const turns = rows.map(r => r.turnMs).filter(v => v != null);
  const inDomain = rows.filter(r => r.type !== 'ood');
  const costs = rows.map(r => r.costUsd).filter(v => v != null);
  return {
    queriesCount: n,
    finishedPct: pct(r => r.finished),
    modeOkPct: pct(r => r.modeOk),
    accuracy: pct(r => r.hit),
    ci95: bootstrapCI(rows.map(r => r.hit)),
    exactAccuracy: pct(r => r.exact),
    slices: { direct: slice('direct'), overlap: slice('overlap'), ood: slice('ood') },
    builtinLikeDomainsAccuracy: hitRate(rows.filter(r => r.type !== 'ood' && overlapsBuiltins(r))),
    externalDomainsAccuracy: hitRate(rows.filter(r => r.type !== 'ood' && !overlapsBuiltins(r))),
    targetExposedPct: Number(((inDomain.filter(r => r.targetExposed).length / inDomain.length) * 100).toFixed(1)),
    meanCatalogCalls: Number(mean(r => r.calls.length).toFixed(2)),
    llmRequests: Number(mean(r => r.requests).toFixed(2)),
    firstRequestPromptTokens: Math.round(mean(r => r.firstRequestPromptTokens)),
    promptTokensPerTask: Math.round(mean(r => r.promptTokens)),
    cacheWriteTokensPerTask: Math.round(mean(r => r.cacheWriteTokens)),
    outputTokensPerTask: Math.round(mean(r => r.outputTokens)),
    p50TurnMs: Math.round(percentile(turns, 50)),
    meanTurnMs: Math.round(turns.reduce((a, b) => a + b, 0) / (turns.length || 1)),
    meanCostUsd: costs.length ? Number((costs.reduce((a, b) => a + b, 0) / costs.length).toFixed(5)) : null,
    totalCostUsd: costs.length ? Number(costs.reduce((a, b) => a + b, 0).toFixed(3)) : null,
    toolSearchUsedPct: pct(r => r.usedToolSearch),
    replEvalsPerTask: Number(mean(r => r.replEvals).toFixed(2)),
    searchToolsUsedPct: pct(r => r.searchQueries.length > 0)
  };
}

async function main() {
  const cases = LIMIT ? DATA.cases.slice(0, LIMIT) : DATA.cases;
  const done = new Map();
  if (fs.existsSync(RAW)) {
    for (const line of fs.readFileSync(RAW, 'utf8').split('\n').filter(Boolean)) {
      const r = JSON.parse(line);
      if (r.finished && r.modeOk) done.set(`${r.arm}:${r.idx}`, r);
    }
  }

  console.log('='.repeat(92));
  console.log(`CLAUDE CODE: CODE MODE vs TOOL-PRUNE [${DATASET}] (${Object.keys(TOOLS).length} tools, ${cases.length} queries, ${MODEL})`);
  console.log(`Arms: ${ARMS.join(', ')} | concurrency ${CONCURRENCY} | resumed ${done.size} cached runs`);
  console.log('='.repeat(92));

  const sessionArms = ARMS.filter(a => a !== 'jev-direct');
  if (ARMS.some(a => a.includes('jev'))) await loadJevRetrieval(cases);

  const summaries = {};
  const rowsByArm = {};
  for (const arm of sessionArms) {
    let completed = 0;
    const rows = await pMap(
      cases,
      async (test, idx) => {
        let row = done.get(`${arm}:${idx}`);
        if (!row) {
          row = await runCase(arm, test, idx);
          // One retry for sessions that never finished a turn (startup hiccups, timeouts).
          if (!row.finished || !row.modeOk) row = await runCase(arm, test, idx);
          fs.appendFileSync(RAW, JSON.stringify(row) + '\n');
        }
        completed += 1;
        process.stdout.write(`  [${arm}] ${completed}/${cases.length}\r`);
        return row;
      },
      CONCURRENCY
    );
    rowsByArm[arm] = rows;
    const s = summarize(rows);
    summaries[arm] = s;
    console.log(
      `${arm.padEnd(20)} acc ${String(s.accuracy).padStart(5)}%  exact ${String(s.exactAccuracy).padStart(5)}%  ` +
        `first-prompt ${String(s.firstRequestPromptTokens).padStart(6)} tok  prompt/task ${String(s.promptTokensPerTask).padStart(6)}  ` +
        `req ${s.llmRequests}  p50 ${s.p50TurnMs} ms  $${s.meanCostUsd}/task  finished ${s.finishedPct}%`
    );
  }

  if (ARMS.includes('jev-direct')) {
    if (!rowsByArm.jev) throw new Error('jev-direct needs the `jev` arm in the same run (cached rows are fine).');
    // Fast path: no Claude Code session at all, just the System One call.
    const rows = rowsByArm.jev.map(fallback => {
      const j = jevCache[fallback.query];
      if (j.confidence < JEV_FAST_PATH) return { ...fallback, arm: 'jev-direct', bypassed: false, turnMs: fallback.turnMs + j.latencyMs };
      const calls = j.choice && j.choice !== 'unsupported_or_none' ? [j.choice] : [];
      const ok = fallback.type === 'ood' ? calls.length === 0 : j.choice === fallback.target;
      return {
        ...fallback, arm: 'jev-direct', bypassed: true, calls, hit: ok, exact: ok,
        requests: 0, promptTokens: 0, firstRequestPromptTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        outputTokens: 0, turnMs: j.latencyMs, costUsd: 0, topLevelTools: [], replEvals: 0, searchQueries: [], usedToolSearch: false
      };
    });
    const s = summarize(rows);
    s.bypassedPct = Number(((rows.filter(r => r.bypassed).length / rows.length) * 100).toFixed(1));
    const by = rows.filter(r => r.bypassed);
    s.bypassedAccuracy = by.length ? Number(((by.filter(r => r.hit).length / by.length) * 100).toFixed(1)) : null;
    summaries['jev-direct'] = s;
    console.log(`jev-direct           acc ${s.accuracy}%  bypassed ${s.bypassedPct}% (acc ${s.bypassedAccuracy}%)  req ${s.llmRequests}  p50 ${s.p50TurnMs} ms  $${s.meanCostUsd}/task`);
  }
  if (Object.keys(jevCache).length) {
    const inD = cases.filter(c => c.type !== 'ood' && jevCache[c.query]);
    const rate = f => Number(((inD.filter(f).length / inD.length) * 100).toFixed(1));
    summaries._jevRetrieval = {
      top1: rate(c => jevCache[c.query].ranked[0] === c.target),
      topKRecall: rate(c => jevCache[c.query].ranked.slice(0, JEV_K).includes(c.target)),
      k: JEV_K,
      p50LatencyMs: Math.round(percentile(cases.map(c => jevCache[c.query].latencyMs), 50))
    };
    console.log('jev retrieval', JSON.stringify(summaries._jevRetrieval));
  }

  let merged = {};
  if (fs.existsSync(OUT)) {
    try {
      merged = JSON.parse(fs.readFileSync(OUT, 'utf8')).models || {};
    } catch {}
  }
  const SAVE = !LIMIT || argv.includes('--save');
  merged[MODEL] = { ...(merged[MODEL] || {}), ...summaries };
  if (SAVE) {
    fs.writeFileSync(
      OUT,
      JSON.stringify(
        {
          evaluatedAt: new Date().toISOString(),
          claudeCodeVersion: '2.1.325',
          dataset: DATASET,
          promptVia: PROMPT_VIA,
          catalogSize: Object.keys(TOOLS).length,
          queriesCount: cases.length,
          pruneK: PRUNE_K,
          instruction: INSTRUCTION,
          models: merged
        },
        null,
        2
      ) + '\n'
    );
    console.log(`\nSaved ${path.relative(process.cwd(), OUT)} (raw rows: ${RAW})`);
  }
}

main();
