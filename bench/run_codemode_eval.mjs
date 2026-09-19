import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS_60 } from './catalog.mjs';
import { CASES_60 } from './cases.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY environment variable is required to run Code Mode eval.');
  process.exit(1);
}

// BM25 / Keyword search implementation for search_tools
function searchTools(query, topK = 5) {
  const qTokens = query.toLowerCase().replace(/[^a-z0-9_]/g, ' ').split(/\s+/).filter(Boolean);
  const toolEntries = Object.entries(TOOLS_60);
  
  const scored = toolEntries.map(([name, meta]) => {
    const text = `${name} ${meta.description} ${meta.criteria}`.toLowerCase();
    let score = 0;
    for (const tok of qTokens) {
      if (name.toLowerCase().includes(tok)) score += 3.0;
      if (text.includes(tok)) score += 1.0;
    }
    return { name, description: meta.description, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).filter(s => s.score > 0);
}

const codeModeToolsDefinition = [
  {
    name: 'search_tools',
    description: 'Search the API catalog for available tools and their documentation signatures.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords to search for in the tool catalog' }
      },
      required: ['query']
    }
  },
  {
    name: 'execute_code',
    description: 'Execute JavaScript code in a secure sandbox. Discovered tools are available on the global `api` object (e.g. `await api.<tool_name>({ ... })`).',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript code to execute' }
      },
      required: ['code']
    }
  }
];

async function callClaude(messages, systemPrompt) {
  const t0 = performance.now();
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: systemPrompt,
      tools: codeModeToolsDefinition,
      messages
    })
  });
  const latency = performance.now() - t0;
  const data = await resp.json();
  const inputTokens = data.usage?.input_tokens || 0;
  const outputTokens = data.usage?.output_tokens || 0;
  return { data, latency, inputTokens, outputTokens };
}

function extractApiCall(code) {
  const match = code.match(/api\.([a-zA-Z0-9_]+)/);
  return match ? match[1] : null;
}

// Concurrency helper
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

async function runCodeModeBenchmark() {
  console.log('='.repeat(78));
  console.log(`EMPIRICAL EVALUATION: CODE MODE (SEARCH + EXECUTE_CODE) ON 60 TOOLS`);
  console.log(`Model: Claude Haiku 4.5 via Anthropic API | Test Cases: ${CASES_60.length} Queries`);
  console.log('='.repeat(78));

  const systemPrompt = `You are an AI agent operating in Code Mode.
You do NOT have the entire catalog of 60 tools preloaded in your context.
You have two tools:
1. search_tools({ query }): Search for available tools by keyword to discover their exact names on the \`api\` object.
2. execute_code({ code }): Execute JavaScript that calls \`await api.<tool_name>(...)\`.

IMPORTANT: You must search the catalog first if you are not certain of the exact tool name. Do NOT hallucinate tool names.`;

  const results = await pMap(CASES_60, async (test, idx) => {
    process.stdout.write(`Evaluating Code Mode [${idx + 1}/${CASES_60.length}]... \r`);

    let totalLatency = 0;
    let totalTokens = 0;
    let turnsUsed = 0;
    let skippedSearch = false;
    let searchFoundTarget = false;
    let apiCalled = null;
    let hallucinatedApi = false;
    let success = false;

    // --- TURN 1 ---
    const messages = [{ role: 'user', content: test.query }];
    const turn1 = await callClaude(messages, systemPrompt);
    totalLatency += turn1.latency;
    totalTokens += turn1.inputTokens + turn1.outputTokens;
    turnsUsed = 1;

    const toolCalls1 = (turn1.data.content || []).filter(c => c.type === 'tool_use');
    const searchCall = toolCalls1.find(tc => tc.name === 'search_tools');
    const execCall1 = toolCalls1.find(tc => tc.name === 'execute_code');

    if (execCall1 && !searchCall) {
      // Model skipped search tool entirely! (Meta-tool blindness)
      skippedSearch = true;
      const code = execCall1.input?.code || '';
      apiCalled = extractApiCall(code);
      hallucinatedApi = !TOOLS_60[apiCalled];
      success = apiCalled === test.target;
    } else if (searchCall) {
      // Model called search_tools
      const searchQuery = searchCall.input?.query || '';
      const searchMatches = searchTools(searchQuery, 5);
      searchFoundTarget = searchMatches.some(m => m.name === test.target);

      // --- TURN 2 ---
      messages.push({ role: 'assistant', content: turn1.data.content });
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: searchCall.id,
            content: JSON.stringify(searchMatches.map(m => ({ tool: m.name, description: m.description })))
          }
        ]
      });

      const turn2 = await callClaude(messages, systemPrompt);
      totalLatency += turn2.latency;
      totalTokens += turn2.inputTokens + turn2.outputTokens;
      turnsUsed = 2;

      const toolCalls2 = (turn2.data.content || []).filter(c => c.type === 'tool_use');
      const execCall2 = toolCalls2.find(tc => tc.name === 'execute_code');

      if (execCall2) {
        const code = execCall2.input?.code || '';
        apiCalled = extractApiCall(code);
        hallucinatedApi = !TOOLS_60[apiCalled];
        success = apiCalled === test.target;
      }
    }

    return {
      query: test.query,
      target: test.target,
      type: test.type,
      success,
      skippedSearch,
      searchFoundTarget,
      apiCalled,
      hallucinatedApi,
      turnsUsed,
      totalLatency,
      totalTokens
    };
  }, 4);

  const total = results.length;
  const successCount = results.filter(r => r.success).length;
  const skippedSearchCount = results.filter(r => r.skippedSearch).length;
  const hallucinatedCount = results.filter(r => r.hallucinatedApi).length;
  const avgLatency = Math.round(results.reduce((a, b) => a + b.totalLatency, 0) / total);
  const avgTokens = Math.round(results.reduce((a, b) => a + b.totalTokens, 0) / total);
  const avgTurns = (results.reduce((a, b) => a + b.turnsUsed, 0) / total).toFixed(1);

  console.log('\n\n--- CODE MODE EMPIRICAL RESULTS (60 Tools, 79 Queries) ---');
  console.log('-'.repeat(78));
  console.log(`Task Accuracy:                 ${((successCount / total) * 100).toFixed(1)}% (${successCount}/${total})`);
  console.log(`Meta-Tool Blindness (No search): ${((skippedSearchCount / total) * 100).toFixed(1)}% (${skippedSearchCount}/${total} queries)`);
  console.log(`API Hallucination Rate:        ${((hallucinatedCount / total) * 100).toFixed(1)}% (${hallucinatedCount}/${total} generated non-existent methods)`);
  console.log(`Average Latency per Query:     ${avgLatency} ms`);
  console.log(`Average Tokens Consumed:       ${avgTokens} tokens`);
  console.log(`Average Interaction Turns:     ${avgTurns} turns`);
  console.log('-'.repeat(78));

  // Save results
  const summary = {
    method: 'codemode',
    model: 'claude-haiku-4-5-20251001',
    queriesCount: total,
    accuracy: (successCount / total) * 100,
    searchBlindnessRate: (skippedSearchCount / total) * 100,
    hallucinationRate: (hallucinatedCount / total) * 100,
    latencyMs: avgLatency,
    tokensPerTurn: avgTokens,
    avgTurns: Number(avgTurns)
  };

  fs.writeFileSync(path.resolve(__dirname, 'codemode_results.json'), JSON.stringify(summary, null, 2));
  console.log('Saved results to bench/codemode_results.json\n');
}

runCodeModeBenchmark();
