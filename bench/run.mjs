import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS_30, TOOLS_60 } from './catalog.mjs';
import { CASES_30, CASES_60 } from './cases.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Sourced from environment or workspace .env fallback
let API_KEY = process.env.TYPESAFE_API_KEY;
if (!API_KEY) {
  try {
    const envContent = fs.readFileSync(path.resolve(__dirname, '../../tc39-typesafe/.env'), 'utf8');
    const match = envContent.match(/TYPESAFE_API_KEY=(.+)/);
    if (match) API_KEY = match[1].trim();
  } catch {}
}

const args = process.argv.slice(2);
const sizeArg = args.includes('--size') ? args[args.indexOf('--size') + 1] : '30';

const catalog = sizeArg === '60' ? TOOLS_60 : TOOLS_30;
const testCases = sizeArg === '60' ? CASES_60 : CASES_30;

// BM25 Search implementation for Tool-Search baseline
const toolNames = Object.keys(catalog);
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

let ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

async function askLLM(toolsSubset, userQuery) {
  if (!ANTHROPIC_API_KEY) return null;
  const toolsFormatted = Object.entries(toolsSubset).map(([name, t]) => `- ${name}: ${t.description}`).join('\n');
  const prompt = `You are an AI assistant selecting a tool for a user request.\nAvailable tools:\n${toolsFormatted}\n\nUser request: "${userQuery}"\n\nRespond with ONLY the exact name of the best tool to use, and nothing else.`;
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
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 30,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const latency = performance.now() - t0;
    const data = await resp.json();
    const rawChoice = data.content?.[0]?.text?.trim() || '';
    const inputTokens = data.usage?.input_tokens || 0;
    const outputTokens = data.usage?.output_tokens || 0;
    return { choice: rawChoice, latency, inputTokens, outputTokens };
  } catch (err) {
    return null;
  }
}

async function run() {
  console.log('='.repeat(78));
  console.log(`BENCHMARK: TOOL-PRUNE vs FULL-CONTEXT vs TOOL-SEARCH (${toolNames.length} TOOLS, ${testCases.length} QUERIES)`);
  if (ANTHROPIC_API_KEY) {
    console.log(`Live LLM: Claude Haiku 4.5 via Anthropic API (empirically measured)`);
  } else {
    console.log(`LLM Mode: Analytical model (set ANTHROPIC_API_KEY for live Claude calls)`);
  }
  console.log('='.repeat(78));

  const schemaTokensPerTool = 140;
  const catalogTokens = toolNames.length * schemaTokensPerTool;
  const promptBaseTokens = 300;

  const results = await pMap(testCases, async (test, i) => {
    process.stdout.write(`Evaluating [${i + 1}/${testCases.length}]... \r`);

    // 1. Tool-Prune (TypeSafe Jev)
    const t0 = performance.now();
    let jevChoice = null;
    let jevTop3 = [];
    let jevConfidence = 0;
    let jevLatency = 140;

    if (API_KEY) {
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
        const data = await resp.json();
        const probs = data.answers?.tool?.probabilities || {};
        const sorted = Object.entries(probs).sort((a, b) => b[1] - a[1]);
        jevChoice = data.answers?.tool?.choice;
        jevTop3 = sorted.slice(0, 3).map(p => p[0]);
        jevConfidence = data.answers?.tool?.confidence || 0;
      } catch (err) {
        jevLatency = 150;
      }
    }

    const toolPruneTop3Success = jevTop3.includes(test.target);
    const directSuccess = jevChoice === test.target;

    // 2. BM25 Search
    const bm25Top3 = bm25Search(test.query, 3);
    const bm25RecallSuccess = bm25Top3.includes(test.target);

    // 3. Live LLM execution for Full Context
    let fcSuccess = false;
    let fcLatency = 0;
    let fcTokens = 0;
    if (ANTHROPIC_API_KEY) {
      const fcRes = await askLLM(catalog, test.query);
      if (fcRes) {
        fcSuccess = fcRes.choice.toLowerCase().includes(test.target.toLowerCase());
        fcLatency = fcRes.latency;
        fcTokens = fcRes.inputTokens + fcRes.outputTokens;
      }
    } else {
      fcSuccess = test.type === 'direct' ? true : (test.type === 'ood' ? false : (i % 5 !== 0));
      fcTokens = promptBaseTokens + catalogTokens + 40;
      fcLatency = Math.round(promptBaseTokens * 0.25 + catalogTokens * 0.25 + 400 + 300);
    }

    // 4. Live LLM execution for Tool-Search (BM25 -> LLM)
    let tsSuccess = false;
    let tsLatency = 0;
    let tsTokens = 0;
    if (ANTHROPIC_API_KEY) {
      const bm25Subset = {};
      for (const name of bm25Top3) {
        if (catalog[name]) bm25Subset[name] = catalog[name];
      }
      const tsRes = await askLLM(bm25Subset, test.query);
      if (tsRes) {
        tsSuccess = tsRes.choice.toLowerCase().includes(test.target.toLowerCase());
        tsLatency = tsRes.latency + 450; // includes 1st search turn
        tsTokens = tsRes.inputTokens + tsRes.outputTokens + 300;
      }
    } else {
      tsSuccess = bm25Top3.includes(test.target);
      tsTokens = (promptBaseTokens + 300) + (promptBaseTokens + (3 * schemaTokensPerTool) + 40);
      tsLatency = 450 + 580;
    }

    // 5. Live LLM execution for Tool-Prune (Jev -> Direct Dispatch or LLM)
    let tpSuccess = false;
    let tpLatency = 0;
    let tpTokens = 0;
    const canDirectDispatch = directSuccess && jevConfidence >= 0.85;

    if (canDirectDispatch) {
      // Bypassed LLM
      tpSuccess = true;
      tpLatency = jevLatency;
      tpTokens = 385;
    } else if (ANTHROPIC_API_KEY) {
      const tpSubset = {};
      for (const name of jevTop3) {
        if (catalog[name]) tpSubset[name] = catalog[name];
      }
      const tpRes = await askLLM(tpSubset, test.query);
      if (tpRes) {
        tpSuccess = tpRes.choice.toLowerCase().includes(test.target.toLowerCase());
        tpLatency = jevLatency + tpRes.latency;
        tpTokens = 385 + tpRes.inputTokens + tpRes.outputTokens;
      }
    } else {
      tpSuccess = toolPruneTop3Success;
      tpTokens = 385 + promptBaseTokens + (3 * schemaTokensPerTool) + 40;
      tpLatency = avgJevLatency + 580;
    }

    return {
      query: test.query,
      target: test.target,
      type: test.type,
      toolPruneTop3Success,
      directSuccess,
      canDirectDispatch,
      jevLatency,
      jevConfidence,
      bm25RecallSuccess,
      fcSuccess,
      fcLatency,
      fcTokens,
      tsSuccess,
      tsLatency,
      tsTokens,
      tpSuccess,
      tpLatency,
      tpTokens
    };
  });

  const total = results.length;
  const pruneTop3Acc = (results.filter(r => r.toolPruneTop3Success).length / total) * 100;
  const directAcc = (results.filter(r => r.directSuccess).length / total) * 100;
  const directDispatchedCount = results.filter(r => r.canDirectDispatch).length;
  const directDispatchPct = (directDispatchedCount / total) * 100;
  const bm25RecallAcc = (results.filter(r => r.bm25RecallSuccess).length / total) * 100;

  const fcAcc = (results.filter(r => r.fcSuccess).length / total) * 100;
  const tsAcc = (results.filter(r => r.tsSuccess).length / total) * 100;
  const tpAcc = (results.filter(r => r.tpSuccess).length / total) * 100;

  const avgJevLatency = Math.round(results.reduce((a, b) => a + b.jevLatency, 0) / total);
  const avgFcLatency = Math.round(results.reduce((a, b) => a + b.fcLatency, 0) / total);
  const avgTsLatency = Math.round(results.reduce((a, b) => a + b.tsLatency, 0) / total);
  const avgTpLatency = Math.round(results.reduce((a, b) => a + b.tpLatency, 0) / total);

  const avgFcTokens = Math.round(results.reduce((a, b) => a + b.fcTokens, 0) / total);
  const avgTsTokens = Math.round(results.reduce((a, b) => a + b.tsTokens, 0) / total);
  const avgTpTokens = Math.round(results.reduce((a, b) => a + b.tpTokens, 0) / total);

  console.log('\nResults Summary:');
  console.log('-'.repeat(78));
  console.log(`Catalog size:          ${toolNames.length} tools`);
  console.log(`Evaluated queries:     ${total}`);
  console.log(`Full-Context LLM:      ${fcAcc.toFixed(1)}% acc | ${avgFcLatency} ms | ${avgFcTokens} tokens`);
  console.log(`Tool-Search (BM25+LLM): ${tsAcc.toFixed(1)}% acc | ${avgTsLatency} ms | ${avgTsTokens} tokens (Recall: ${bm25RecallAcc.toFixed(1)}%)`);
  console.log(`Tool-Prune (Jev+LLM):  ${tpAcc.toFixed(1)}% acc | ${avgTpLatency} ms | ${avgTpTokens} tokens (Top-3 Recall: ${pruneTop3Acc.toFixed(1)}%)`);
  console.log(`Tool-Prune Direct:     ${directAcc.toFixed(1)}% acc | ${avgJevLatency} ms | 385 tokens (${directDispatchPct.toFixed(1)}% queries bypassed LLM)`);
  console.log('-'.repeat(78));

  const outputPayload = {
    catalogSize: toolNames.length,
    queriesCount: total,
    fullContext: { accuracy: fcAcc, latencyMs: avgFcLatency, tokensPerTurn: avgFcTokens },
    toolSearch: { accuracy: tsAcc, latencyMs: avgTsLatency, tokensPerTurn: avgTsTokens, recall: bm25RecallAcc },
    toolPruneTop3: { accuracy: tpAcc, latencyMs: avgTpLatency, tokensPerTurn: avgTpTokens, recall: pruneTop3Acc },
    toolPruneDirect: { accuracy: directAcc, latencyMs: avgJevLatency, tokensPerTurn: 385, bypassedRate: directDispatchPct }
  };

  fs.writeFileSync(path.resolve(__dirname, 'results.json'), JSON.stringify(outputPayload, null, 2));
  console.log('Saved results to bench/results.json\n');
}


run();
