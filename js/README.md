# tool-prune

Calibrated tool selection and schema pruning for AI agents. Zero dependencies.

```bash
npm install tool-prune
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
console.log(match.confidence); // 1.0
```

`prune()` narrows schemas to Top-K candidates or identifies direct matches in ~140ms. `dispatch()` runs immediate tool execution if confidence clears the threshold. That's the whole API.

## Schema pruning for LLMs

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

```js
const result = await router.dispatch('read ./package.json', {
  readFile: (query) => fs.readFileSync('package.json', 'utf8'),
  runQuery: (query) => db.query(query),
  fallback: (query, match) => callLLM(query)
});
```

Runs deterministic handlers in under 160ms with zero token cost.

## Config

Set `TYPESAFE_API_KEY` in your environment, or pass options directly:

```js
const router = prune(tools, {
  apiKey: 'apikey_...', // defaults to process.env.TYPESAFE_API_KEY
  threshold: 0.85,     // confidence ceiling for fast-path dispatch
  topK: 3              // candidate schemas to retain
});
```

## Demo

```bash
npm run demo
```

Runs live quickstart routing with your `TYPESAFE_API_KEY`.

## License

MIT © [Hemanth.HM](https://h3manth.com)
