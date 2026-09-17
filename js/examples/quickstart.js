import toolPrune from '../index.js';

const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) {
  console.error('Error: TYPESAFE_API_KEY environment variable is required.');
  process.exit(1);
}

const tools = {
  readFile: 'Read raw text from local file path',
  runQuery: 'Execute read-only SQL SELECT queries against database',
  webSearch: 'Search public internet for documentation or news',
  gitStatus: 'Check git working tree status and modified files'
};

const pruner = toolPrune(tools, { apiKey });

console.log('--- 1. Select Tool ---');
const res = await pruner.select('show me modified files in repo');
console.log(`Tool: ${res.tool} (confidence: ${res.confidence}, probability: ${res.probability}, latency: ${res.latency.toFixed(1)}ms)`);

console.log('\n--- 2. Prune Top-2 Candidates for LLM Prompt ---');
const top2 = await pruner.filter('what columns are in the users table?', { k: 2 });
console.log('Pruned candidate schemas:', top2);

console.log('\n--- 3. Direct Dispatch ---');
const output = await pruner.dispatch('find latest news on TC39', {
  webSearch: (q) => `[Executed webSearch for: "${q}"]`,
  runQuery: (q) => `[Executed SQL query: "${q}"]`,
  fallback: (q) => `[Escalated to LLM: "${q}"]`
});
console.log('Dispatch output:', output);
