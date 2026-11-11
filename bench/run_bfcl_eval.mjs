import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TurboQuantSearch } from './turboquant.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Optional turboquant-search WASM package
let TurboSearch = null;
try {
  const mod = await import('turboquant-search');
  TurboSearch = mod.TurboSearch;
} catch {}

// Optional TypeSafe API Key (env or local .env)
let API_KEY = process.env.TYPESAFE_API_KEY;
if (!API_KEY) {
  try {
    const envContent = fs.readFileSync(path.resolve(__dirname, '../.env'), 'utf8');
    const match = envContent.match(/^TYPESAFE_API_KEY=(.+)$/m);
    if (match) API_KEY = match[1].trim();
  } catch {}
}

const limitArgIdx = process.argv.indexOf('--limit');
const LIMIT = limitArgIdx !== -1 ? Number(process.argv[limitArgIdx + 1]) : Infinity;

// Load official Gorilla BFCL v3 multiple dataset
const bfclPath = path.resolve(__dirname, 'bfcl_dataset/BFCL_v3_multiple.json');
const ansPath = path.resolve(__dirname, 'bfcl_dataset/BFCL_v3_multiple_answers.json');

const questions = fs.readFileSync(bfclPath, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map(line => JSON.parse(line));

const answersRaw = fs.readFileSync(ansPath, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map(line => JSON.parse(line));

const answerMap = new Map();
for (const a of answersRaw) {
  const targets = (a.ground_truth || []).map(gt => Object.keys(gt)[0]).filter(Boolean);
  answerMap.set(a.id, targets);
}

function toToolEntry(fn) {
  const paramKeys = Object.keys(fn.parameters?.properties || {});
  return {
    name: fn.name,
    description: fn.description || fn.name,
    parameters: fn.parameters,
    criteria: `${fn.description || ''} ${paramKeys.join(' ')}`.trim()
  };
}

// Build global pool of all 443 unique tool names in BFCL_v3_multiple
// (merging variant descriptions when a generic name recurs across rows)
const globalToolsMap = new Map();
for (const q of questions) {
  for (const fn of q.function) {
    const entry = toToolEntry(fn);
    if (!globalToolsMap.has(fn.name)) {
      globalToolsMap.set(fn.name, entry);
    } else {
      const existing = globalToolsMap.get(fn.name);
      if (entry.description && !existing.description.includes(entry.description)) {
        existing.description = `${existing.description} ${entry.description}`.trim();
        existing.criteria = `${existing.criteria} ${entry.criteria}`.trim();
      }
    }
  }
}
const globalAllTools = Array.from(globalToolsMap.values());

// All valid single-target multi-tool test items (N = 200 across BFCL_v3_multiple)
const validTestSet = [];
for (const q of questions) {
  const targets = answerMap.get(q.id) || [];
  if (targets.length === 1 && q.function.length >= 2) {
    validTestSet.push({
      id: q.id,
      query: q.question[0][0].content,
      target: targets[0],
      candidates: q.function.map(toToolEntry)
    });
  }
}

const EVAL_SET = validTestSet.slice(0, LIMIT);

// Deterministic 100-tool catalog builder: includes the query's exact local candidate
// schemas (2-4 tools) plus deterministic distractors from the global BFCL pool up to 100 tools.
function buildCatalog100(test, idx) {
  const map = new Map();
  for (const c of test.candidates) {
    map.set(c.name, c);
  }
  const totalGlobal = globalAllTools.length;
  let cursor = (idx * 37) % totalGlobal;
  let scanned = 0;
  while (map.size < 100 && scanned < totalGlobal) {
    const cand = globalAllTools[cursor];
    if (!map.has(cand.name)) {
      map.set(cand.name, cand);
    }
    cursor = (cursor + 1) % totalGlobal;
    scanned++;
  }
  return Array.from(map.values());
}

async function pMap(array, fn, concurrency = 5) {
  const results = new Array(array.length);
  let index = 0;
  const workers = new Array(concurrency).fill(null).map(async () => {
    while (index < array.length) {
      const i = index++;
      results[i] = await fn(array[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// Fair BM25 baseline: splits camelCase, snake_case, and dotted tool names
function tokenizeIdentifierAware(str) {
  return String(str || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function buildBm25Index(candidateList) {
  const docTokensList = candidateList.map(c =>
    tokenizeIdentifierAware(`${c.name} ${c.description} ${c.criteria}`)
  );
  const N = candidateList.length || 1;
  const avgdl = docTokensList.reduce((acc, t) => acc + t.length, 0) / N;
  const dfMap = new Map();
  const tfMaps = docTokensList.map(tokens => {
    const tf = new Map();
    const seen = new Set();
    for (const t of tokens) {
      tf.set(t, (tf.get(t) || 0) + 1);
      if (!seen.has(t)) {
        seen.add(t);
        dfMap.set(t, (dfMap.get(t) || 0) + 1);
      }
    }
    return tf;
  });
  return { candidateList, docTokensList, tfMaps, dfMap, avgdl, N };
}

function queryBm25Index(index, query, topK = 5) {
  const qTokens = tokenizeIdentifierAware(query);
  const { candidateList, docTokensList, tfMaps, dfMap, avgdl, N } = index;
  const scores = new Array(N);
  for (let i = 0; i < N; i++) {
    const tfMap = tfMaps[i];
    const dl = docTokensList[i].length;
    let score = 0;
    for (const qt of qTokens) {
      const tf = tfMap.get(qt) || 0;
      if (tf === 0) continue;
      const df = dfMap.get(qt) || 0;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      score += (idf * (tf * 2.5)) / (tf + 1.5 * (0.25 + 0.75 * (dl / avgdl)));
    }
    scores[i] = { name: candidateList[i].name, score };
  }
  scores.sort((a, b) => b.score - a.score);
  return scores.slice(0, topK).map(s => s.name);
}

async function queryJev(query, criteriaObj) {
  const t0 = performance.now();
  const resp = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'jev-latest',
      state: { user_intent: query },
      questions: {
        tool: {
          type: 'choice',
          instructions: 'Which specific tool is required to satisfy this intent?',
          criteria: criteriaObj
        }
      }
    })
  });
  const latency = performance.now() - t0;
  if (!resp.ok) {
    throw new Error(`TypeSafe HTTP ${resp.status}`);
  }
  const data = await resp.json();
  const probs = data.answers?.tool?.probabilities || {};
  const ranked = Object.entries(probs).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const choice = data.answers?.tool?.choice || ranked[0] || '';
  return { choice, ranked, latency };
}

async function runBFCLBenchmark() {
  console.log('==============================================================================');
  console.log('BFCL v3 TOOL RETRIEVAL & SCHEMA PRUNING BENCHMARK');
  console.log(`Dataset: Gorilla BFCL_v3_multiple | N = ${EVAL_SET.length}/${validTestSet.length} Queries | ${globalAllTools.length} Unique Tools`);
  console.log('Note: Evaluates tool-name retrieval (Top-1) & schema pruning recall (Top-3/5),');
  console.log('      not end-to-end LLM argument AST generation.');
  console.log('==============================================================================\n');

  // Pre-build static full-pool (443 unique tools) indices once
  const globalAllMap = Object.fromEntries(globalAllTools.map(t => [t.name, t]));
  const globalTq443 = new TurboQuantSearch();
  globalTq443.index(globalAllMap);
  const globalBm25_443 = buildBm25Index(globalAllTools);

  let globalWasm443 = null;
  if (TurboSearch) {
    globalWasm443 = await TurboSearch.from(globalAllTools, {
      fields: ['name', 'description', 'criteria'],
      dim: 384,
      bits: 3
    });
  }

  const results = await pMap(EVAL_SET, async (test, idx) => {
    process.stdout.write(`Evaluating [${idx + 1}/${EVAL_SET.length}]...\r`);

    // --- TEST 1: Local Distractor Selection (2-4 tools) ---
    const localBm25 = buildBm25Index(test.candidates);
    const bm25CandT0 = performance.now();
    const bm25CandRes = queryBm25Index(localBm25, test.query, test.candidates.length);
    const bm25DistractorLatency = performance.now() - bm25CandT0;
    const bm25DistractorTop1 = bm25CandRes[0] === test.target;

    const localTq = new TurboQuantSearch();
    localTq.index(Object.fromEntries(test.candidates.map(c => [c.name, c])));
    const tqCandT0 = performance.now();
    const tqCandidateRes = localTq.search(test.query, test.candidates.length);
    const tqDistractorLatency = performance.now() - tqCandT0;
    const tqDistractorTop1 = tqCandidateRes[0]?.name === test.target;

    let wasmDistractorTop1 = false;
    let wasmDistractorLatency = 0;
    if (TurboSearch) {
      const tsLocal = await TurboSearch.from(test.candidates, {
        fields: ['name', 'description', 'criteria'],
        dim: 384,
        bits: 3
      });
      const t0 = performance.now();
      const wRes = await tsLocal.search(test.query, { topK: test.candidates.length });
      wasmDistractorLatency = performance.now() - t0;
      wasmDistractorTop1 = wRes[0]?.data?.name === test.target;
      tsLocal.destroy();
    }

    let jevDistractorTop1 = false;
    let jevDistractorLatency = 0;
    if (API_KEY) {
      const candCriteria = Object.fromEntries(test.candidates.map(c => [c.name, c.criteria]));
      try {
        const jRes = await queryJev(test.query, candCriteria);
        jevDistractorTop1 = jRes.choice === test.target;
        jevDistractorLatency = jRes.latency;
      } catch {}
    }

    // --- TEST 2: Deterministic 100-Tool Schema Pruning (N = 200, 0 skipped) ---
    const catalog100 = buildCatalog100(test, idx);
    const catalog100Map = Object.fromEntries(catalog100.map(t => [t.name, t]));

    const tq100 = new TurboQuantSearch();
    tq100.index(catalog100Map);
    const tq100T0 = performance.now();
    const tq100Res = tq100.search(test.query, 5);
    const tq100Latency = performance.now() - tq100T0;
    const tq100Top1 = tq100Res[0]?.name === test.target;
    const tq100Top3 = tq100Res.slice(0, 3).some(r => r.name === test.target);
    const tq100Top5 = tq100Res.some(r => r.name === test.target);

    const bm25_100 = buildBm25Index(catalog100);
    const bm25_100T0 = performance.now();
    const bm25_100Res = queryBm25Index(bm25_100, test.query, 5);
    const bm25_100Latency = performance.now() - bm25_100T0;
    const bm25_100Top1 = bm25_100Res[0] === test.target;
    const bm25_100Top3 = bm25_100Res.slice(0, 3).includes(test.target);
    const bm25_100Top5 = bm25_100Res.includes(test.target);

    let wasm100Top1 = false, wasm100Top3 = false, wasm100Top5 = false, wasm100Latency = 0;
    if (TurboSearch) {
      const ts100 = await TurboSearch.from(catalog100, {
        fields: ['name', 'description', 'criteria'],
        dim: 384,
        bits: 3
      });
      const t0 = performance.now();
      const wRes = await ts100.search(test.query, { topK: 5 });
      wasm100Latency = performance.now() - t0;
      wasm100Top1 = wRes[0]?.data?.name === test.target;
      wasm100Top3 = wRes.slice(0, 3).some(r => r.data?.name === test.target);
      wasm100Top5 = wRes.some(r => r.data?.name === test.target);
      ts100.destroy();
    }

    let jev100Top1 = false, jev100Top3 = false, jev100Top5 = false, jev100Latency = 0;
    if (API_KEY) {
      const crit100 = Object.fromEntries(catalog100.map(t => [t.name, t.criteria]));
      try {
        const jRes = await queryJev(test.query, crit100);
        jev100Top1 = jRes.choice === test.target;
        jev100Top3 = jRes.ranked.slice(0, 3).includes(test.target);
        jev100Top5 = jRes.ranked.slice(0, 5).includes(test.target);
        jev100Latency = jRes.latency;
      } catch {}
    }

    // --- TEST 3: Full 443-Tool Global Pool Pruning (N = 200) ---
    const tq443T0 = performance.now();
    const tq443Res = globalTq443.search(test.query, 5);
    const tq443Latency = performance.now() - tq443T0;
    const tq443Top1 = tq443Res[0]?.name === test.target;
    const tq443Top3 = tq443Res.slice(0, 3).some(r => r.name === test.target);
    const tq443Top5 = tq443Res.some(r => r.name === test.target);

    const bm443T0 = performance.now();
    const bm443Res = queryBm25Index(globalBm25_443, test.query, 5);
    const bm443Latency = performance.now() - bm443T0;
    const bm443Top1 = bm443Res[0] === test.target;
    const bm443Top3 = bm443Res.slice(0, 3).includes(test.target);
    const bm443Top5 = bm443Res.includes(test.target);

    let wasm443Top1 = false, wasm443Top3 = false, wasm443Top5 = false, wasm443Latency = 0;
    if (globalWasm443) {
      const t0 = performance.now();
      const wRes = await globalWasm443.search(test.query, { topK: 5 });
      wasm443Latency = performance.now() - t0;
      wasm443Top1 = wRes[0]?.data?.name === test.target;
      wasm443Top3 = wRes.slice(0, 3).some(r => r.data?.name === test.target);
      wasm443Top5 = wRes.some(r => r.data?.name === test.target);
    }

    // Two-stage TurboQuant Top-200 -> TypeSafe Jev for >255 tool catalogs
    let jev443Top1 = false, jev443Top3 = false, jev443Top5 = false, jev443Latency = 0;
    if (API_KEY) {
      const stageT0 = performance.now();
      const shortlist200 = globalTq443.search(test.query, 200);
      const crit200 = Object.fromEntries(shortlist200.map(r => [r.name, globalAllMap[r.name].criteria]));
      try {
        const jRes = await queryJev(test.query, crit200);
        jev443Latency = performance.now() - stageT0;
        jev443Top1 = jRes.choice === test.target;
        jev443Top3 = jRes.ranked.slice(0, 3).includes(test.target);
        jev443Top5 = jRes.ranked.slice(0, 5).includes(test.target);
      } catch {}
    }

    return {
      id: test.id,
      query: test.query,
      target: test.target,
      bm25DistractorTop1,
      bm25DistractorLatency,
      tqDistractorTop1,
      tqDistractorLatency,
      wasmDistractorTop1,
      wasmDistractorLatency,
      jevDistractorTop1,
      jevDistractorLatency,
      tq100Top1,
      tq100Top3,
      tq100Top5,
      tq100Latency,
      bm25_100Top1,
      bm25_100Top3,
      bm25_100Top5,
      bm25_100Latency,
      wasm100Top1,
      wasm100Top3,
      wasm100Top5,
      wasm100Latency,
      jev100Top1,
      jev100Top3,
      jev100Top5,
      jev100Latency,
      tq443Top1,
      tq443Top3,
      tq443Top5,
      tq443Latency,
      bm443Top1,
      bm443Top3,
      bm443Top5,
      bm443Latency,
      wasm443Top1,
      wasm443Top3,
      wasm443Top5,
      wasm443Latency,
      jev443Top1,
      jev443Top3,
      jev443Top5,
      jev443Latency
    };
  }, 6);

  if (globalWasm443) globalWasm443.destroy();

  const total = results.length;
  const pct = (arr, key) =>
    arr.length ? `${((arr.filter(r => r[key]).length / arr.length) * 100).toFixed(1)}%` : '0.0%';
  const avg = (arr, key) =>
    arr.length ? arr.reduce((a, b) => a + b[key], 0) / arr.length : 0;

  console.log(`\n\n--- BENCHMARK 1: BFCL v3 Local Distractor Selection (2-4 Tools, N = ${total}) ---`);
  console.log('-----------------------------------------------------------------------------------------');
  console.log('Method                         │ Top-1 Accuracy │ Search Latency │ Network Required');
  console.log('───────────────────────────────┼────────────────┼────────────────┼───────────────────────');
  if (API_KEY) {
    console.log(`TypeSafe System One (Jev)      │ ${pct(results, 'jevDistractorTop1').padEnd(14)} │ ~${Math.round(avg(results, 'jevDistractorLatency'))} ms        │ Yes (Cloud API)`);
  }
  if (TurboSearch) {
    console.log(`turboquant-search (WASM)       │ ${pct(results, 'wasmDistractorTop1').padEnd(14)} │ ${avg(results, 'wasmDistractorLatency').toFixed(3)} ms      │ No (100% Offline)`);
  }
  console.log(`TurboQuant (Pure JS built-in)  │ ${pct(results, 'tqDistractorTop1').padEnd(14)} │ ${avg(results, 'tqDistractorLatency').toFixed(3)} ms      │ No (100% Offline)`);
  console.log(`BM25 Baseline (ident-split)    │ ${pct(results, 'bm25DistractorTop1').padEnd(14)} │ ${avg(results, 'bm25DistractorLatency').toFixed(3)} ms      │ No (100% Offline)`);
  console.log('-----------------------------------------------------------------------------------------');

  console.log(`\n--- BENCHMARK 2: BFCL v3 100-Tool Schema Pruning (N = ${total}, 0 Skipped) ---`);
  console.log('-----------------------------------------------------------------------------------------');
  console.log('Method                         │ Top-1          │ Top-3 Recall   │ Top-5 Recall   │ Search Latency');
  console.log('───────────────────────────────┼────────────────┼────────────────┼────────────────┼───────────────');
  if (API_KEY) {
    console.log(`TypeSafe System One (Jev)      │ ${pct(results, 'jev100Top1').padEnd(14)} │ ${pct(results, 'jev100Top3').padEnd(14)} │ ${pct(results, 'jev100Top5').padEnd(14)} │ ~${Math.round(avg(results, 'jev100Latency'))} ms (Cloud)`);
  }
  if (TurboSearch) {
    console.log(`turboquant-search (WASM)       │ ${pct(results, 'wasm100Top1').padEnd(14)} │ ${pct(results, 'wasm100Top3').padEnd(14)} │ ${pct(results, 'wasm100Top5').padEnd(14)} │ ${avg(results, 'wasm100Latency').toFixed(3)} ms (Local)`);
  }
  console.log(`TurboQuant (Pure JS built-in)  │ ${pct(results, 'tq100Top1').padEnd(14)} │ ${pct(results, 'tq100Top3').padEnd(14)} │ ${pct(results, 'tq100Top5').padEnd(14)} │ ${avg(results, 'tq100Latency').toFixed(3)} ms (Local)`);
  console.log(`BM25 Baseline (ident-split)    │ ${pct(results, 'bm25_100Top1').padEnd(14)} │ ${pct(results, 'bm25_100Top3').padEnd(14)} │ ${pct(results, 'bm25_100Top5').padEnd(14)} │ ${avg(results, 'bm25_100Latency').toFixed(3)} ms (Local)`);
  console.log('-----------------------------------------------------------------------------------------');

  console.log(`\n--- BENCHMARK 3: BFCL v3 Full ${globalAllTools.length}-Tool Global Pool Pruning (N = ${total}) ---`);
  console.log('-----------------------------------------------------------------------------------------');
  console.log('Method                         │ Top-1          │ Top-3 Recall   │ Top-5 Recall   │ Search Latency');
  console.log('───────────────────────────────┼────────────────┼────────────────┼────────────────┼───────────────');
  if (API_KEY) {
    console.log(`TypeSafe System One (Jev)      │ ${pct(results, 'jev443Top1').padEnd(14)} │ ${pct(results, 'jev443Top3').padEnd(14)} │ ${pct(results, 'jev443Top5').padEnd(14)} │ ~${Math.round(avg(results, 'jev443Latency'))} ms (Cloud)`);
  }
  if (TurboSearch) {
    console.log(`turboquant-search (WASM)       │ ${pct(results, 'wasm443Top1').padEnd(14)} │ ${pct(results, 'wasm443Top3').padEnd(14)} │ ${pct(results, 'wasm443Top5').padEnd(14)} │ ${avg(results, 'wasm443Latency').toFixed(3)} ms (Local)`);
  }
  console.log(`TurboQuant (Pure JS built-in)  │ ${pct(results, 'tq443Top1').padEnd(14)} │ ${pct(results, 'tq443Top3').padEnd(14)} │ ${pct(results, 'tq443Top5').padEnd(14)} │ ${avg(results, 'tq443Latency').toFixed(3)} ms (Local)`);
  console.log(`BM25 Baseline (ident-split)    │ ${pct(results, 'bm443Top1').padEnd(14)} │ ${pct(results, 'bm443Top3').padEnd(14)} │ ${pct(results, 'bm443Top5').padEnd(14)} │ ${avg(results, 'bm443Latency').toFixed(3)} ms (Local)`);
  console.log('-----------------------------------------------------------------------------------------');
}

runBFCLBenchmark();
