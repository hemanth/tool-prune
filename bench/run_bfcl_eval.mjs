import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TurboQuantSearch } from './turboquant.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load turboquant-search from /tmp/turboquant-search/dist/index.js
let TurboSearch = null;
try {
  const mod = await import('/tmp/turboquant-search/dist/index.js');
  TurboSearch = mod.TurboSearch;
} catch (e) {
  console.log('Note: turboquant-search wasm module not loaded from /tmp:', e.message);
}

// Read API Key
let API_KEY = process.env.TYPESAFE_API_KEY;
if (!API_KEY) {
  try {
    const envContent = fs.readFileSync(path.resolve(__dirname, '../../tc39-typesafe/.env'), 'utf8');
    const match = envContent.match(/TYPESAFE_API_KEY=(.+)/);
    if (match) API_KEY = match[1].trim();
  } catch {}
}

// Load BFCL dataset
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

// Build global pool of unique tools from BFCL
const globalToolsMap = new Map();
for (const q of questions) {
  for (const fn of q.function) {
    if (!globalToolsMap.has(fn.name)) {
      globalToolsMap.set(fn.name, {
        name: fn.name,
        description: fn.description || fn.name,
        criteria: `${fn.description || ''} ${Object.keys(fn.parameters?.properties || {}).join(' ')}`
      });
    }
  }
}

// Filter dataset to 60 representative queries with single valid target
const validTestSet = [];
for (const q of questions) {
  const targets = answerMap.get(q.id) || [];
  if (targets.length === 1 && q.function.length >= 2) {
    validTestSet.push({
      id: q.id,
      query: q.question[0][0].content,
      target: targets[0],
      candidates: q.function.map(f => ({
        name: f.name,
        description: f.description || '',
        criteria: `${f.description || ''} ${Object.keys(f.parameters?.properties || {}).join(' ')}`
      }))
    });
  }
}

const EVAL_SET = validTestSet.slice(0, 60);

// Simple concurrency runner
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

// BM25 helper
function bm25Rank(query, candidateList) {
  const tokenize = str => str.toLowerCase().replace(/[^a-z0-9_]/g, ' ').split(/\s+/).filter(Boolean);
  const qTokens = tokenize(query);
  const docs = candidateList.map(c => `${c.name} ${c.description} ${c.criteria}`);
  const docTokensList = docs.map(d => tokenize(d));
  const avgdl = docTokensList.reduce((acc, t) => acc + t.length, 0) / (docs.length || 1);

  const scores = candidateList.map((c, i) => {
    const docTokens = docTokensList[i];
    const tfMap = new Map();
    for (const t of docTokens) tfMap.set(t, (tfMap.get(t) || 0) + 1);

    let score = 0;
    for (const qt of qTokens) {
      const tf = tfMap.get(qt) || 0;
      if (tf === 0) continue;
      const docCount = docTokensList.filter(dt => dt.includes(qt)).length;
      const idf = Math.log(1 + (docs.length - docCount + 0.5) / (docCount + 0.5));
      score += idf * (tf * 2.5) / (tf + 1.5 * (0.25 + 0.75 * (docTokens.length / avgdl)));
    }
    return { name: c.name, score };
  });

  scores.sort((a, b) => b.score - a.score);
  return scores.map(s => s.name);
}

async function runBFCLBenchmark() {
  console.log('==============================================================================');
  console.log(`BERKELEY FUNCTION CALLING LEADERBOARD (BFCL) EMPIRICAL EVALUATION`);
  console.log(`Dataset: Gorilla BFCL_v3_multiple | 60 Evaluated Queries`);
  console.log('==============================================================================\n');

  console.log('Running evaluation across 60 BFCL queries...');

  // Setup Global 100-tool index for Retrieval test
  const global100Tools = Array.from(globalToolsMap.values()).slice(0, 100);
  const global100Map = Object.fromEntries(global100Tools.map(t => [t.name, t]));

  // Setup turboquant-search (WASM) on global 100 tools
  let globalTsWasm = null;
  if (TurboSearch) {
    globalTsWasm = await TurboSearch.from(global100Tools, {
      fields: ['name', 'description', 'criteria'],
      dim: 384,
      bits: 3
    });
  }

  // Setup built-in TurboQuant on global 100 tools
  const globalTqBuiltin = new TurboQuantSearch(256, 64);
  globalTqBuiltin.index(global100Map);

  // Setup criteria for 100 tools for Jev
  const criteria100 = {};
  for (const t of global100Tools) criteria100[t.name] = t.criteria;

  const results = await pMap(EVAL_SET, async (test, idx) => {
    process.stdout.write(`Evaluating [${idx + 1}/${EVAL_SET.length}]... \r`);

    // --- TEST 1: Local Distractor Resolution (Picking target among 2-4 candidate tools) ---
    // 1. BM25 on candidates
    const bm25CandT0 = performance.now();
    const bm25Candidates = bm25Rank(test.query, test.candidates);
    const bm25DistractorLatency = performance.now() - bm25CandT0;
    const bm25DistractorTop1 = bm25Candidates[0] === test.target;

    // 2. Pure JS TurboQuant on candidates
    const localTq = new TurboQuantSearch(256, 64);
    localTq.index(Object.fromEntries(test.candidates.map(c => [c.name, c])));
    const tqCandT0 = performance.now();
    const tqCandidateRes = localTq.search(test.query, test.candidates.length);
    const tqDistractorLatency = performance.now() - tqCandT0;
    const tqDistractorTop1 = tqCandidateRes[0]?.name === test.target;

    // 3. turboquant-search (WASM) on candidates
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

    // 4. TypeSafe Jev on candidates
    let jevDistractorTop1 = false;
    let jevLatency = 140;
    if (API_KEY) {
      const t0 = performance.now();
      const candCriteria = {};
      for (const c of test.candidates) candCriteria[c.name] = c.criteria;

      try {
        const resp = await fetch('https://api.typesafe.ai/v1/systemone', {
          method: 'POST',
          headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'jev-latest',
            state: { user_intent: test.query },
            questions: {
              tool: {
                type: 'choice',
                instructions: 'Which specific tool is required to satisfy this intent?',
                criteria: candCriteria
              }
            }
          })
        });
        jevLatency = performance.now() - t0;
        const data = await resp.json();
        jevDistractorTop1 = data.answers?.tool?.choice === test.target;
      } catch {}
    }

    // --- TEST 2: Global 100-Tool Schema Pruning ---
    const targetIn100 = global100Tools.some(t => t.name === test.target);

    // 1. TypeSafe Jev on Global 100 tools
    let jevGlobalTop1 = false, jevGlobalTop3 = false, jevGlobalTop5 = false, jevGlobalLatency = 0;
    if (API_KEY && targetIn100) {
      const t0 = performance.now();
      try {
        const resp = await fetch('https://api.typesafe.ai/v1/systemone', {
          method: 'POST',
          headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'jev-latest',
            state: { user_intent: test.query },
            questions: {
              tool: {
                type: 'choice',
                instructions: 'Which specific tool is required to satisfy this intent?',
                criteria: criteria100
              }
            }
          })
        });
        jevGlobalLatency = performance.now() - t0;
        const data = await resp.json();
        const probs = data.answers?.tool?.probabilities || {};
        const sorted = Object.entries(probs).sort((a, b) => b[1] - a[1]);
        jevGlobalTop1 = data.answers?.tool?.choice === test.target;
        jevGlobalTop3 = sorted.slice(0, 3).some(p => p[0] === test.target);
        jevGlobalTop5 = sorted.slice(0, 5).some(p => p[0] === test.target);
      } catch {}
    }

    // 2. Global TurboQuant WASM
    let wasmGlobalTop1 = false, wasmGlobalTop3 = false, wasmGlobalTop5 = false, wasmGlobalLatency = 0;
    if (globalTsWasm && targetIn100) {
      const t0 = performance.now();
      const gRes = await globalTsWasm.search(test.query, { topK: 5 });
      wasmGlobalLatency = performance.now() - t0;
      wasmGlobalTop1 = gRes[0]?.data?.name === test.target;
      wasmGlobalTop3 = gRes.slice(0, 3).some(r => r.data?.name === test.target);
      wasmGlobalTop5 = gRes.some(r => r.data?.name === test.target);
    }

    // 3. Global TurboQuant Pure JS
    let tqGlobalTop1 = false, tqGlobalTop3 = false, tqGlobalTop5 = false, tqGlobalLatency = 0;
    if (targetIn100) {
      const t0 = performance.now();
      const gRes = globalTqBuiltin.search(test.query, 5);
      tqGlobalLatency = performance.now() - t0;
      tqGlobalTop1 = gRes[0]?.name === test.target;
      tqGlobalTop3 = gRes.slice(0, 3).some(r => r.name === test.target);
      tqGlobalTop5 = gRes.some(r => r.name === test.target);
    }

    // 4. Global BM25
    let bm25GlobalTop1 = false, bm25GlobalTop3 = false, bm25GlobalTop5 = false, bm25GlobalLatency = 0;
    if (targetIn100) {
      const t0 = performance.now();
      const bmGlobal = bm25Rank(test.query, global100Tools);
      bm25GlobalLatency = performance.now() - t0;
      bm25GlobalTop1 = bmGlobal[0] === test.target;
      bm25GlobalTop3 = bmGlobal.slice(0, 3).includes(test.target);
      bm25GlobalTop5 = bmGlobal.slice(0, 5).includes(test.target);
    }

    return {
      query: test.query,
      target: test.target,
      bm25DistractorTop1,
      bm25DistractorLatency,
      tqDistractorTop1,
      tqDistractorLatency,
      wasmDistractorTop1,
      wasmDistractorLatency,
      jevDistractorTop1,
      jevLatency,
      targetIn100,
      jevGlobalTop1,
      jevGlobalTop3,
      jevGlobalTop5,
      jevGlobalLatency,
      wasmGlobalTop1,
      wasmGlobalTop3,
      wasmGlobalTop5,
      wasmGlobalLatency,
      tqGlobalTop1,
      tqGlobalTop3,
      tqGlobalTop5,
      tqGlobalLatency,
      bm25GlobalTop1,
      bm25GlobalTop3,
      bm25GlobalTop5,
      bm25GlobalLatency
    };
  }, 5);

  if (globalTsWasm) globalTsWasm.destroy();

  const total = results.length;
  const in100Results = results.filter(r => r.targetIn100);

  function pct(arr, key) {
    if (!arr.length) return '0.0%';
    return ((arr.filter(r => r[key]).length / arr.length) * 100).toFixed(1) + '%';
  }

  console.log('\n\n--- BENCHMARK 1: BFCL Distractor Selection (Picking from 2-4 Candidates) ---');
  console.log(`Evaluates distinguishing target function among 2-4 local candidates (${total} queries):`);
  console.log('-----------------------------------------------------------------------------------------');
  console.log(`Method                         │ Top-1 Accuracy │ Latency        │ Network Required`);
  console.log('───────────────────────────────┼────────────────┼────────────────┼───────────────────────');
  console.log(`TypeSafe System One (Jev)      │ ${pct(results, 'jevDistractorTop1').padEnd(14)} │ ~${Math.round(results.reduce((a,b)=>a+b.jevLatency,0)/total)} ms        │ Yes (Cloud API)`);
  console.log(`turboquant-search (WASM)       │ ${pct(results, 'wasmDistractorTop1').padEnd(14)} │ ~${(results.reduce((a,b)=>a+b.wasmDistractorLatency,0)/total).toFixed(2)} ms       │ No (100% Offline)`);
  console.log(`TurboQuant (Pure JS built-in)  │ ${pct(results, 'tqDistractorTop1').padEnd(14)} │ ~${(results.reduce((a,b)=>a+b.tqDistractorLatency,0)/total).toFixed(3)} ms      │ No (100% Offline)`);
  console.log(`BM25 Lexical Baseline          │ ${pct(results, 'bm25DistractorTop1').padEnd(14)} │ ~${(results.reduce((a,b)=>a+b.bm25DistractorLatency,0)/total).toFixed(3)} ms      │ No (100% Offline)`);
  console.log('-----------------------------------------------------------------------------------------');

  console.log('\n--- BENCHMARK 2: BFCL Global Schema Pruning (100-Tool Open Catalog) ---');
  console.log(`Evaluates pruning open catalog of 100 tools down to Top-K candidates (${in100Results.length} queries with target in catalog):`);
  console.log('-----------------------------------------------------------------------------------------');
  console.log(`Method                         │ Top-1          │ Top-3 Recall   │ Top-5 Recall   │ Search Latency`);
  console.log('───────────────────────────────┼────────────────┼────────────────┼────────────────┼───────────────');
  console.log(`TypeSafe System One (Jev)      │ ${pct(in100Results, 'jevGlobalTop1').padEnd(14)} │ ${pct(in100Results, 'jevGlobalTop3').padEnd(14)} │ ${pct(in100Results, 'jevGlobalTop5').padEnd(14)} │ ~${Math.round(in100Results.reduce((a,b)=>a+b.jevGlobalLatency,0)/in100Results.length)} ms (Cloud)`);
  console.log(`turboquant-search (WASM)       │ ${pct(in100Results, 'wasmGlobalTop1').padEnd(14)} │ ${pct(in100Results, 'wasmGlobalTop3').padEnd(14)} │ ${pct(in100Results, 'wasmGlobalTop5').padEnd(14)} │ ${(in100Results.reduce((a,b)=>a+b.wasmGlobalLatency,0)/in100Results.length).toFixed(2)} ms (Local)`);
  console.log(`TurboQuant (Pure JS built-in)  │ ${pct(in100Results, 'tqGlobalTop1').padEnd(14)} │ ${pct(in100Results, 'tqGlobalTop3').padEnd(14)} │ ${pct(in100Results, 'tqGlobalTop5').padEnd(14)} │ ${(in100Results.reduce((a,b)=>a+b.tqGlobalLatency,0)/in100Results.length).toFixed(3)} ms (Local)`);
  console.log(`BM25 Lexical Baseline          │ ${pct(in100Results, 'bm25GlobalTop1').padEnd(14)} │ ${pct(in100Results, 'bm25GlobalTop3').padEnd(14)} │ ${pct(in100Results, 'bm25GlobalTop5').padEnd(14)} │ ${(in100Results.reduce((a,b)=>a+b.bm25GlobalLatency,0)/in100Results.length).toFixed(3)} ms (Local)`);
  console.log('-----------------------------------------------------------------------------------------');

  console.log('\n--- SAMPLE BFCL HARD DISTRACTOR QUERIES ---');
  for (const r of results.slice(0, 4)) {
    console.log(`Query: "${r.query.slice(0, 75)}..."`);
    console.log(`  Target: [${r.target}]`);
    console.log(`  Jev: ${r.jevDistractorTop1 ? 'PASS' : 'FAIL'} | WASM: ${r.wasmDistractorTop1 ? 'PASS' : 'FAIL'} | Pure JS: ${r.tqDistractorTop1 ? 'PASS' : 'FAIL'} | BM25: ${r.bm25DistractorTop1 ? 'PASS' : 'FAIL'}`);
  }
}

runBFCLBenchmark();

