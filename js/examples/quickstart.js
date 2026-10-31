import toolPrune from '../index.js';

const tools = {
  readFile: 'Read raw text from local file path',
  runQuery: 'Execute read-only SQL SELECT queries against database tables and columns',
  webSearch: 'Search public internet for documentation, articles, or news',
  gitStatus: 'Check git working tree status and modified files in repository'
};

// Uses offline TurboQuant automatically, or TypeSafe System One if TYPESAFE_API_KEY is set
const pruner = toolPrune(tools);

console.log('--- 1. Select Tool ---');
const res = await pruner.select('show me modified files in repo');
console.log(`Tool: ${res.tool} (engine: ${res.engine}, confidence: ${res.confidence.toFixed(3)}, latency: ${res.latency.toFixed(2)}ms)`);

console.log('\n--- 2. Adaptive Conformal Prune for LLM Prompt ---');
const candidates = await pruner.filter('select email from users table');
console.log('Pruned candidate schemas:', candidates);

console.log('\n--- 3. Direct Dispatch ---');
const output = await pruner.dispatch('search public internet for latest TC39 news', {
  webSearch: (q) => `[Executed webSearch for: "${q}"]`,
  runQuery: (q) => `[Executed SQL query: "${q}"]`,
  fallback: (q) => `[Escalated to LLM: "${q}"]`
});
console.log('Dispatch output:', output);
