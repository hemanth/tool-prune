# tool-prune

Calibrated tool selection and schema pruning for AI agents. Dual-engine: zero-dependency offline TurboQuant or TypeSafe System One.

[**Live Interactive Playground →**](https://hemanth.github.io/tool-prune/)

```bash
npm install tool-prune
# or
pip install tool-prune

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

`prune()` runs offline via TurboQuant by default, or routes to TypeSafe System One when `TYPESAFE_API_KEY` is present. That's the whole API.

## Schema pruning for LLMs

Instead of dumping 100 MCP tool schemas into every prompt, prune them to the relevant candidates before calling your LLM:

```js
const router = prune(tools);

// Auto-selects candidates dynamically based on confidence drop-off:
const topTools = await router.filter(userPrompt);

// Or pass fixed k:
// const topTools = await router.filter(userPrompt, { k: 5 });

const response = await llm.chat({
  tools: topTools,
  messages: [{ role: 'user', content: userPrompt }]
});
```

`filter()` automatically detects the optimal tool set based on score distribution, or accepts `{ k: 5 }` for fixed top-K. Cuts prompt tokens by up to 92% and eliminates context confusion.


## Fast-path direct dispatch

Bypass the LLM entirely when confidence clears your threshold:

```js
const result = await router.dispatch('read ./package.json', {
  readFile: (query) => fs.readFileSync('package.json', 'utf8'),
  runQuery: (query) => db.query(query),
  fallback: (query, match) => callLLM(query)
});
```

Deterministic tool execution in under 160ms with zero LLM generation cost.

## Dual engine

Select between offline vector search and cloud reasoning:

```js
// Explicitly pick engine
const localMatch = await prune(query, tools, { engine: 'turboquant' });
const cloudMatch = await prune(query, tools, { engine: 'typesafe', apiKey: '...' });
```

- **turboquant**: 100% offline, zero network, zero dependencies. Uses `turboquant-search` (WASM SIMD) in JS or `turbovec` (Rust SIMD) in Python if installed, with seamless built-in FWHT fallback.
- **typesafe**: Cloud System One reasoning (Jev). 100% Top-1 accuracy on subtle distractors with calibrated probabilities.

## Python

Identical API and zero required dependencies:

```python
from tool_prune import prune, ToolPrune

# One-shot offline pruning
match = prune("what tables exist in the db?", tools)
print(match.tool, match.engine)

# Reusable router for LLM prompt pruning (auto-selects candidates)
router = ToolPrune(tools)
candidates = router.filter(user_prompt)  # or router.filter(user_prompt, k=5)
```

## Berkeley Function Calling Leaderboard (BFCL v3)

Evaluated on Gorilla BFCL v3 multiple-tool benchmark:

| Engine | Backend | Distractor Top-1 | 100-Tool Top-5 Prune | Latency | Network |
|---|---|---|---|---|---|
| **TypeSafe (Jev)** | Cloud System One | **100.0%** | **100.0%** | 258 ms | Cloud API |
| **TurboQuant** | JS WASM (`turboquant-search`) | 86.7% | 85.0% | 14 ms | Offline |
| **TurboQuant** | Python Rust (`turbovec`) | 85.0% | 82.5% | 0.023 ms | Offline |
| **TurboQuant** | Pure JS / Python (built-in) | 83.3% | 82.5% | 0.4 ms | Offline |

Run evaluation:

```bash
node bench/run_bfcl_eval.mjs
python3 bench/run_turbovec_bench.py
```

## License

MIT © [Hemanth.HM](https://h3manth.com)
