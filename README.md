# tool-prune

Calibrated tool selection and schema pruning for AI agents. Zero dependencies.

```bash
npm install tool-prune
# or
pip install tool-prune
```

## Quick start

```js
import prune from 'tool-prune';

const tools = {
  readFile: 'Read raw text from local filesystem path',
  runQuery: 'Execute SQL queries against database',
  webSearch: 'Search public web for documentation or articles'
};

const match = await prune('what tables exist in the db?', tools);
console.log(match.tool);       // 'runQuery'
console.log(match.confidence); // 1.0
```

`prune()` narrows schemas to Top-K candidates or identifies direct matches in ~140ms. `dispatch()` runs immediate tool execution if confidence clears the threshold. That's the whole API.

## Schema pruning for LLMs

Instead of dumping 60 MCP tool definitions into every prompt, prune them to the top candidates before calling your LLM:

```js
const router = prune(tools);
const topTools = await router.filter(userPrompt, { k: 3 });

const response = await llm.chat({
  tools: topTools,
  messages: [{ role: 'user', content: userPrompt }]
});
```

Drops prompt tokens by 75-85% and eliminates context distraction without losing tools.

## Fast-path direct dispatch

Bypass the LLM entirely when confidence clears the threshold:

```js
const result = await router.dispatch('read ./package.json', {
  readFile: (query) => fs.readFileSync('package.json', 'utf8'),
  runQuery: (query) => db.query(query),
  fallback: (query, match) => callLLM(query)
});
```

Runs deterministic handlers in under 160ms with zero token cost.

## Python

Identical API and zero third-party dependencies:

```python
from tool_prune import prune, ToolPrune

match = prune("what tables exist in the db?", tools)
print(match.tool, match.confidence)

# Or as a reusable router
router = ToolPrune(tools)
candidates = router.filter(user_prompt, k=3)
```

## Benchmark

Evaluated across 60 realistic tools with semantic collision zones against standard baselines:

| Method | LLM Turns | Accuracy | Latency | Tokens / Turn |
|---|---|---|---|---|
| Full-Context Injection | 1 | 86.1% | 2,875 ms | 8,740 |
| Tool-Search-Tool | 2 | 87.3% | 1,030 ms | 1,360 |
| **tool-prune (Top-3)** | 1 | **100.0%** | **741 ms** | **1,145** |
| **tool-prune (Direct)** | **0** | **97.5%** | **161 ms** | **385** |

Run the benchmarks:

```bash
node bench/run.mjs --size 30
node bench/run.mjs --size 60
```

## License

MIT © [Hemanth.HM](https://h3manth.com)
