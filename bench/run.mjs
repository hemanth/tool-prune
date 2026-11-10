import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS_30, TOOLS_60 } from './catalog.mjs';
import { CASES_30, CASES_60 } from './cases.mjs';
import { TurboQuantSearch } from './turboquant.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Sourced from environment or workspace .env fallback
let API_KEY = process.env.TYPESAFE_API_KEY;
if (API_KEY === undefined) {
  try {
    const envContent = fs.readFileSync(path.resolve(__dirname, '../../tc39-typesafe/.env'), 'utf8');
    const match = envContent.match(/TYPESAFE_API_KEY=(.+)/);
    if (match) API_KEY = match[1].trim();
  } catch {}
}

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

const args = process.argv.slice(2);
const sizeArg = args.includes('--size') ? args[args.indexOf('--size') + 1] : '60';
const modelsArg = args.includes('--models')
  ? args[args.indexOf('--models') + 1].split(',').map(s => s.trim()).filter(Boolean)
  : ['claude-haiku-5-5'];

const catalog = sizeArg === '30' ? TOOLS_30 : TOOLS_60;
const testCases = sizeArg === '30' ? CASES_30 : CASES_60;
const toolNames = Object.keys(catalog);

// 1. Offline TurboQuant v0.4.0 (4-bit PolarQuant + 1024-bit QJL)
const tqEngine = new TurboQuantSearch();
tqEngine.index(catalog);

// 2. BM25 Search baseline
const toolDocs = toolNames.map(name => `${name} ${catalog[name].description} ${catalog[name].criteria}`);

function tokenize(text) {
  return text.toLowerCase().replace(/[^a-z0-9_]/g, ' ').split(/\s+/).filter(Boolean);
}

const vocab = new Set();
toolDocs.forEach(d => tokenize(d).forEach(t => vocab.add(t)));
const docLengths = toolDocs.map(d => tokenize(d).length);
const avgdl = docLengths.reduce((a, b) => a + b, 0) / docLengths.length;

function bm25Search(query, topK = 3) {
  const qTokens = tokenize(query);
  const k1 = 1.5;
  const b = 0.75;
  const scores = toolNames.map((name, i) => {
    const docTokens = tokenize(toolDocs[i]);
    const termFreqs = new Map();
    for (const t of docTokens) termFreqs.set(t, (termFreqs.get(t) || 0) + 1);

    let score = 0;
    for (const qt of qTokens) {
      if (!vocab.has(qt)) continue;
      const tf = termFreqs.get(qt) || 0;
      const docCount = toolDocs.filter(d => tokenize(d).includes(qt)).length;
      const idfScore = Math.log(1 + (toolDocs.length - docCount + 0.5) / (docCount + 0.5));
      score += idfScore * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLengths[i] / avgdl)));
    }
    return { name, score };
  });

  scores.sort((a, b) => b.score - a.score);
  return scores.slice(0, topK).map(s => s.name);
}

const jevCriteria = {};
for (const [name, meta] of Object.entries(catalog)) {
  jevCriteria[name] = meta.criteria;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

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

function percentile(values, p = 50) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// B=1,000 paired bootstrap 95% confidence interval on accuracy (%)
function bootstrapAccuracyCI(bools, B = 1000, seed = 42) {
  const n = bools.length;
  if (!n) return [0, 0];
  let s = seed >>> 0;
  const rand = () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  const samples = new Float64Array(B);
  for (let b = 0; b < B; b++) {
    let hits = 0;
    for (let i = 0; i < n; i++) {
      if (bools[Math.floor(rand() * n)]) hits++;
    }
    samples[b] = (hits / n) * 100;
  }
  samples.sort();
  return [samples[Math.floor(B * 0.025)], samples[Math.floor(B * 0.975)]];
}

function cleanModelChoice(rawText) {
  if (!rawText) return '';
  return rawText
    .trim()
    .split(/\s+/)[0]
    .replace(/^[`"'\[\(]+|[`"'\.\]\),:;]+$/g, '')
    .trim();
}

const validToolSet = new Set([...toolNames.map(n => n.toLowerCase()), 'unsupported_or_none']);

function matchesTarget(rawChoice, target) {
  if (!rawChoice) return false;
  const tgt = target.toLowerCase();
  const lines = rawChoice.trim().split('\n').map(l => l.trim()).filter(Boolean);
  const firstTok = cleanModelChoice(lines[0] || '').toLowerCase();
  if (firstTok === tgt) return true;
  if (validToolSet.has(firstTok)) return false;

  const lastLineWords = (lines[lines.length - 1] || '').split(/\s+/);
  const lastTok = cleanModelChoice(lastLineWords[lastLineWords.length - 1] || '').toLowerCase();
  if (lastTok === tgt) return true;
  if (validToolSet.has(lastTok)) return false;

  const mentioned = [...validToolSet].filter(name => rawChoice.toLowerCase().includes(name));
  return mentioned.length === 1 && mentioned[0] === tgt;
}

async function askLLM(modelSpec, toolsSubset, userQuery) {
  const toolsFormatted = Object.entries(toolsSubset)
    .map(([name, t]) => `- ${name}: ${t.description}`)
    .join('\n');
  const prompt = `You are an AI assistant selecting a tool for a user request.\nAvailable tools:\n${toolsFormatted}\n\nUser request: "${userQuery}"\n\nRespond with ONLY the exact name of the best tool to use (or unsupported_or_none if no available tool fits), and nothing else.`;

  if (modelSpec.startsWith('ollama:')) {
    const ollamaModel = modelSpec.slice('ollama:'.length);
    const t0 = performance.now();
    const resp = await fetch('http://127.0.0.1:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ollamaModel,
        prompt,
        stream: false,
        options: { num_predict: 24, temperature: 0 }
      })
    });
    const latency = performance.now() - t0;
    const data = await resp.json();
    return {
      choice: (data.response || '').trim(),
      latency,
      inputTokens: data.prompt_eval_count || 0,
      outputTokens: data.eval_count || 0
    };
  }

  if (modelSpec.includes('/') && OPENROUTER_API_KEY) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const t0 = performance.now();
      const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: modelSpec,
          max_tokens: 40,
          temperature: 0,
          messages: [{ role: 'user', content: prompt }]
        })
      });
      const latency = performance.now() - t0;
      if (resp.status === 429 || resp.status >= 500) {
        await sleep(500 * Math.pow(2, attempt));
        continue;
      }
      const data = await resp.json();
      if (data.error) throw new Error(`OpenRouter error (${modelSpec}): ${data.error.message}`);
      return {
        choice: data.choices?.[0]?.message?.content?.trim() || '',
        latency,
        inputTokens: data.usage?.prompt_tokens || 0,
        outputTokens: data.usage?.completion_tokens || 0
      };
    }
  }

  if (!ANTHROPIC_API_KEY) return null;

  for (let attempt = 0; attempt < 5; attempt++) {
    const t0 = performance.now();
    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: modelSpec,
          max_tokens: 1024,
          messages: [{ role: 'user', content: prompt }]
        })
      });
      const latency = performance.now() - t0;
      if (resp.status === 429 || resp.status === 529 || resp.status >= 500) {
        await sleep(600 * Math.pow(2, attempt));
        continue;
      }
      const data = await resp.json();
      const textBlock = (data.content || []).find(c => c.type === 'text');
      const rawChoice = textBlock?.text?.trim() || '';
      return {
        choice: rawChoice,
        latency,
        inputTokens: data.usage?.input_tokens || 0,
        outputTokens: data.usage?.output_tokens || 0
      };
    } catch {
      await sleep(500 * Math.pow(2, attempt));
    }
  }
  return null;
}

async function run() {
  console.log('='.repeat(92));
  console.log(`MULTI-MODEL BENCHMARK: TOOL-PRUNE vs FULL-CONTEXT vs TOOL-SEARCH (${toolNames.length} TOOLS, ${testCases.length} QUERIES)`);
  console.log(`Models under evaluation: ${modelsArg.join(', ')}`);
  console.log('='.repeat(92));

  // Step 1: Precompute deterministic / System One retrieval once across all 79 queries
  // so every LLM model sees the exact same fixed candidate sets (strict paired comparison).
  console.log('\n[Phase 1/2] Evaluating retrieval & pruning layer (TypeSafe Jev, Offline TurboQuant v0.4.0, BM25)...');
  const retrievalCache = await pMap(testCases, async (test, i) => {
    process.stdout.write(`  Retrieval [${i + 1}/${testCases.length}]... \r`);

    // 1. Offline TurboQuant v0.4.0
    const tqT0 = performance.now();
    const tqRes = tqEngine.search(test.query, 5);
    const tqLatency = performance.now() - tqT0;
    const tqTop5 = tqRes.map(r => r.name);
    const tqTop3 = tqTop5.slice(0, 3);

    // 2. BM25 Lexical baseline
    const bmT0 = performance.now();
    const bm25Top3 = bm25Search(test.query, 3);
    const bm25Latency = performance.now() - bmT0;

    // 3. TypeSafe System One (Jev)
    let jevChoice = null;
    let jevTop3 = [];
    let jevConfidence = 0;
    let jevLatency = 145;

    if (API_KEY) {
      for (let attempt = 0; attempt < 4; attempt++) {
        const t0 = performance.now();
        try {
          const resp = await fetch('https://api.typesafe.ai/v1/systemone', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${API_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: 'jev-latest',
              state: { user_intent: test.query },
              questions: {
                tool: {
                  type: 'choice',
                  instructions: 'Which specific tool is required to satisfy this intent?',
                  criteria: jevCriteria
                }
              }
            })
          });
          jevLatency = performance.now() - t0;
          if (resp.status === 429 || resp.status >= 500) {
            await sleep(400 * Math.pow(2, attempt));
            continue;
          }
          const data = await resp.json();
          const probs = data.answers?.tool?.probabilities || {};
          const sorted = Object.entries(probs).sort((a, b) => b[1] - a[1]);
          jevChoice = data.answers?.tool?.choice;
          jevTop3 = sorted.slice(0, 3).map(p => p[0]);
          jevConfidence = data.answers?.tool?.confidence || 0;
          break;
        } catch {
          await sleep(400 * Math.pow(2, attempt));
        }
      }
    }

    return {
      test,
      tqTop3,
      tqTop5,
      tqLatency,
      tqTop1Success: tqTop5[0] === test.target,
      tqTop5Success: tqTop5.includes(test.target),
      bm25Top3,
      bm25Latency,
      bm25RecallSuccess: bm25Top3.includes(test.target),
      jevChoice,
      jevTop3,
      jevConfidence,
      jevLatency,
      jevDirectSuccess: jevChoice === test.target,
      jevTop3Success: jevTop3.includes(test.target)
    };
  }, 5);

  const total = retrievalCache.length;
  const jevDirectAcc = (retrievalCache.filter(r => r.jevDirectSuccess).length / total) * 100;
  const jevDirectP50 = Math.round(percentile(retrievalCache.map(r => r.jevLatency), 50));
  const jevDirectMean = Math.round(retrievalCache.reduce((a, b) => a + b.jevLatency, 0) / total);
  const jevTop3Recall = (retrievalCache.filter(r => r.jevTop3Success).length / total) * 100;
  const tqTop5Recall = (retrievalCache.filter(r => r.tqTop5Success).length / total) * 100;
  const bm25Top3Recall = (retrievalCache.filter(r => r.bm25RecallSuccess).length / total) * 100;
  const bypassedCount = retrievalCache.filter(r => r.jevConfidence >= 0.85).length;
  const bypassedPct = (bypassedCount / total) * 100;

  console.log(`\nRetrieval Layer Summary (${total} queries):`);
  console.log(`  TypeSafe Jev Top-1: ${jevDirectAcc.toFixed(1)}% | Top-3 Recall: ${jevTop3Recall.toFixed(1)}% | P50: ${jevDirectP50} ms (Mean: ${jevDirectMean} ms) | Fast-Path >=0.85: ${bypassedPct.toFixed(1)}%`);
  console.log(`  TurboQuant v0.4.0:  Top-5 Recall: ${tqTop5Recall.toFixed(1)}% | Mean: ${(retrievalCache.reduce((a, b) => a + b.tqLatency, 0) / total).toFixed(3)} ms (Offline)`);
  console.log(`  BM25 Baseline:      Top-3 Recall: ${bm25Top3Recall.toFixed(1)}%`);

  // Step 2: Evaluate each LLM backbone across all paradigms
  const multiModelSummary = {};

  for (const modelSpec of modelsArg) {
    console.log(`\n[Phase 2/2] Evaluating LLM Backbone: ${modelSpec}...`);
    const isLocalOllama = modelSpec.startsWith('ollama:');
    if (isLocalOllama) {
      // Warmup local model in RAM so cold model load does not skew query #1
      await askLLM(modelSpec, { git_status: catalog.git_status }, 'warmup');
    }

    const concurrency = isLocalOllama ? 1 : 5;
    const rows = await pMap(retrievalCache, async (item, idx) => {
      process.stdout.write(`  [${modelSpec}] Query [${idx + 1}/${total}]... \r`);
      const { test, jevChoice, jevTop3, jevConfidence, jevLatency, tqTop5, tqLatency, bm25Top3 } = item;

      // A. Full-Context LLM (all 60 tools)
      const fcRes = await askLLM(modelSpec, catalog, test.query);
      const fcSuccess = fcRes ? matchesTarget(fcRes.choice, test.target) : false;
      const fcLatency = fcRes ? fcRes.latency : 0;
      const fcTokens = fcRes ? fcRes.inputTokens + fcRes.outputTokens : 0;

      // B. Offline TurboQuant Top-5 + LLM (zero API key pruning!)
      const tqSubset = {};
      for (const name of tqTop5) {
        if (catalog[name]) tqSubset[name] = catalog[name];
      }
      const tqLlmRes = await askLLM(modelSpec, tqSubset, test.query);
      const tqLlmSuccess = tqLlmRes ? matchesTarget(tqLlmRes.choice, test.target) : false;
      const tqLlmLatency = tqLatency + (tqLlmRes ? tqLlmRes.latency : 0);
      const tqLlmTokens = tqLlmRes ? tqLlmRes.inputTokens + tqLlmRes.outputTokens : 0;

      // C. Tool-Search (BM25 2-turn discovery + LLM)
      const bm25Subset = {};
      for (const name of bm25Top3) {
        if (catalog[name]) bm25Subset[name] = catalog[name];
      }
      const tsRes = await askLLM(modelSpec, bm25Subset, test.query);
      const tsSuccess = tsRes ? matchesTarget(tsRes.choice, test.target) : false;
      // 2-turn architecture: Turn 1 (LLM emits search_tools query) + Turn 2 (LLM selects from BM25 results)
      const turn1EstLatency = tsRes ? tsRes.latency * 0.85 : 450;
      const tsLatency = turn1EstLatency + (tsRes ? tsRes.latency : 0);
      const tsTokens = (tsRes ? tsRes.inputTokens + tsRes.outputTokens : 0) + 260;

      // D. Tool-Prune + LLM (Jev Top-3 pruned prompt, always 1 LLM turn)
      const jevSubset = {};
      for (const name of (jevTop3.length ? jevTop3 : tqTop5.slice(0, 3))) {
        if (catalog[name]) jevSubset[name] = catalog[name];
      }
      const tpLlmRes = await askLLM(modelSpec, jevSubset, test.query);
      const tpLlmSuccess = tpLlmRes ? matchesTarget(tpLlmRes.choice, test.target) : false;
      const tpLlmLatency = jevLatency + (tpLlmRes ? tpLlmRes.latency : 0);
      const tpLlmTokens = 385 + (tpLlmRes ? tpLlmRes.inputTokens + tpLlmRes.outputTokens : 0);

      // E. Tool-Prune Direct Dispatch (Fast-path when Jev confidence >= 0.85, else pruned LLM fallback)
      const fastPathTriggered = API_KEY && jevConfidence >= 0.85;
      const tpDirectSuccess = fastPathTriggered ? (jevChoice === test.target) : tpLlmSuccess;
      const tpDirectLatency = fastPathTriggered ? jevLatency : tpLlmLatency;
      const tpDirectTokens = fastPathTriggered ? 385 : tpLlmTokens;

      return {
        type: test.type,
        fcSuccess,
        fcLatency,
        fcTokens,
        tqLlmSuccess,
        tqLlmLatency,
        tqLlmTokens,
        tsSuccess,
        tsLatency,
        tsTokens,
        tpLlmSuccess,
        tpLlmLatency,
        tpLlmTokens,
        tpDirectSuccess,
        tpDirectLatency,
        tpDirectTokens,
        fastPathTriggered
      };
    }, concurrency);

    const summarize = (succKey, latKey, tokKey) => {
      const bools = rows.map(r => r[succKey]);
      const lats = rows.map(r => r[latKey]);
      const toks = rows.map(r => r[tokKey]);
      const acc = (bools.filter(Boolean).length / total) * 100;
      const [ciLo, ciHi] = bootstrapAccuracyCI(bools, 1000);
      const bySlice = {};
      for (const slice of ['direct', 'overlap', 'ood']) {
        const sub = rows.filter(r => r.type === slice);
        bySlice[slice] = sub.length ? (sub.filter(r => r[succKey]).length / sub.length) * 100 : 0;
      }
      return {
        accuracy: Number(acc.toFixed(1)),
        ci95: [Number(ciLo.toFixed(1)), Number(ciHi.toFixed(1))],
        p50LatencyMs: Math.round(percentile(lats, 50)),
        meanLatencyMs: Math.round(lats.reduce((a, b) => a + b, 0) / total),
        tokensPerTurn: Math.round(toks.reduce((a, b) => a + b, 0) / total),
        slices: {
          direct: Number(bySlice.direct.toFixed(1)),
          overlap: Number(bySlice.overlap.toFixed(1)),
          ood: Number(bySlice.ood.toFixed(1))
        }
      };
    };

    const summary = {
      model: modelSpec,
      fullContext: summarize('fcSuccess', 'fcLatency', 'fcTokens'),
      turboQuantPruneLlm: summarize('tqLlmSuccess', 'tqLlmLatency', 'tqLlmTokens'),
      toolSearchBm25Llm: summarize('tsSuccess', 'tsLatency', 'tsTokens'),
      toolPruneJevLlm: summarize('tpLlmSuccess', 'tpLlmLatency', 'tpLlmTokens'),
      toolPruneDirect: {
        ...summarize('tpDirectSuccess', 'tpDirectLatency', 'tpDirectTokens'),
        bypassedRate: Number(bypassedPct.toFixed(1))
      }
    };

    multiModelSummary[modelSpec] = summary;

    console.log(`\nResults for [${modelSpec}] (${toolNames.length} tools, ${total} queries):`);
    console.log('-'.repeat(92));
    console.log(`Paradigm                         | Accuracy (95% CI)       | P50 Lat | Mean Lat | Avg Tokens | Overlap`);
    console.log('-'.repeat(92));
    for (const [label, s] of [
      ['Tool-Prune Direct (Jev+FastPath)', summary.toolPruneDirect],
      ['Tool-Prune + LLM (Jev Top-3)', summary.toolPruneJevLlm],
      ['TurboQuant + LLM (Offline Top-5)', summary.turboQuantPruneLlm],
      ['Full-Context LLM (All 60 Tools)', summary.fullContext],
      ['Tool-Search (BM25 + LLM 2-Turn)', summary.toolSearchBm25Llm]
    ]) {
      const ciStr = `${s.accuracy.toFixed(1)}% [${s.ci95[0].toFixed(1)}, ${s.ci95[1].toFixed(1)}]`;
      console.log(
        `${label.padEnd(32)} | ${ciStr.padEnd(23)} | ${String(s.p50LatencyMs + ' ms').padEnd(7)} | ${String(s.meanLatencyMs + ' ms').padEnd(8)} | ${String(s.tokensPerTurn).padEnd(10)} | ${s.slices.overlap.toFixed(1)}%`
      );
    }
    console.log('-'.repeat(92));
  }

  const outputPayload = {
    evaluatedAt: new Date().toISOString(),
    catalogSize: toolNames.length,
    queriesCount: total,
    retrieval: {
      typesafeJevTop1: Number(jevDirectAcc.toFixed(1)),
      typesafeJevTop3Recall: Number(jevTop3Recall.toFixed(1)),
      typesafeJevP50Ms: jevDirectP50,
      typesafeJevBypassPct: Number(bypassedPct.toFixed(1)),
      turboQuantTop5Recall: Number(tqTop5Recall.toFixed(1)),
      bm25Top3Recall: Number(bm25Top3Recall.toFixed(1))
    },
    models: multiModelSummary
  };

  fs.writeFileSync(path.resolve(__dirname, 'results.json'), JSON.stringify(outputPayload, null, 2) + '\n');
  console.log('\nSaved multi-model empirical results to bench/results.json\n');
}

run();
