# tool-prune

Calibrated tool selection and schema pruning for AI agents. Dual-engine: zero-dependency offline TurboQuant or TypeSafe System One.

```bash
npm install tool-prune

# Optional SIMD acceleration
npm install turboquant-search

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

// Works offline out of the box with TurboQuant:
const match = await prune('what tables exist in the db?', tools);
console.log(match.tool);   // 'runQuery'
console.log(match.engine); // 'turboquant'
```

`prune()` narrows schemas offline via TurboQuant by default, or routes to TypeSafe System One when `TYPESAFE_API_KEY` is present. That's the whole API.

## Schema pruning for LLMs

```js
const router = prune(tools);
const topTools = await router.filter(userPrompt, { k: 5 });

const response = await llm.chat({
  tools: topTools,
  messages: [{ role: 'user', content: userPrompt }]
});
```

Cuts prompt tokens by up to 92% and eliminates context confusion without losing tools.

## Fast-path direct dispatch

```js
const result = await router.dispatch('read ./package.json', {
  readFile: (query) => fs.readFileSync('package.json', 'utf8'),
  runQuery: (query) => db.query(query),
  fallback: (query, match) => callLLM(query)
});
```

Runs deterministic handlers in under 160ms with zero token cost.

## Dual engine

```js
const localMatch = await prune(query, tools, { engine: 'turboquant' });
const cloudMatch = await prune(query, tools, { engine: 'typesafe', apiKey: '...' });
```

- **turboquant**: 100% offline, zero network, zero dependencies. Uses `turboquant-search` (WASM SIMD) if installed, with built-in FWHT fallback.
- **typesafe**: Cloud System One reasoning (Jev). 100% Top-1 accuracy on subtle distractors with calibrated probabilities.

## Demo

```bash
npm run demo
```

## License

MIT © [Hemanth.HM](https://h3manth.com)
