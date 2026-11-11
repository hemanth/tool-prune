# tool-prune

Calibrated tool selection and schema pruning for AI agents. Zero-dependency offline TurboQuant, on-device WebGPU/WASM engines, or TypeSafe System One.

```bash
npm install tool-prune

# Optional: TypeSafe API key for cloud reasoning
export TYPESAFE_API_KEY="apikey_..."
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
console.log(match.confidence); // 0.815
console.log(match.engine);     // 'turboquant'
```

`prune()` runs offline via 4-bit PolarQuant + 1024-bit QJL TurboQuant (`0.11 ms`, 99.0% BFCL v3 Top-1 and 99.0% 100-Tool Top-5 recall across all `N = 200` `BFCL_v3_multiple` queries) by default, or routes to TypeSafe System One when `TYPESAFE_API_KEY` is set. Accepts plain dicts, MCP `inputSchema`, Anthropic `input_schema`, and OpenAI `{ type: 'function', function }` tool arrays.

## Schema pruning for LLMs

```js
const router = prune(mcpTools);

// Conformal auto-selection (or pass { k: 5 }):
const topTools = await router.filter(userPrompt, { allowEmpty: true });

const response = await llm.chat({
  tools: topTools,
  messages: [{ role: 'user', content: userPrompt }]
});
```

Cuts prompt schema tokens by up to 98% while preserving your exact SDK tool objects.

## Fast-path direct dispatch

```js
const result = await router.dispatch('read ./package.json', {
  readFile: (query) => fs.readFileSync('package.json', 'utf8'),
  runQuery: (query) => db.query(query),
  fallback: (query, match) => callLLM(query, match.autoTools)
});
```

## Pluggable engines

```js
const localMatch = await prune(query, tools, { engine: 'turboquant' });
const cloudMatch = await prune(query, tools, { engine: 'typesafe', apiKey: '...' });
const onDevice   = await prune(query, tools, { engine: decisionEngine });
```

- **turboquant**: 100% offline, zero network, zero dependencies (`0.18 ms` per 100-tool query). Pass `engine: 'turboquant-wasm'` to opt into `turboquant-search` WASM if installed.
- **custom engine**: Any object with `choice({ state, question, options })` (such as `webml-kit`) or function `(query, criteria) => candidates`.
- **typesafe**: Cloud System One reasoning (Jev) with calibrated probabilities.

## Demo

```bash
npm run demo
```

## License

MIT © [Hemanth.HM](https://h3manth.com)
