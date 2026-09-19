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
| **TypeSafe (Jev)** | Cloud System One | **100.0%** | **100.0%** | 189 ms | Cloud API |
| **TurboQuant** | JS WASM (`turboquant-search`) | 86.7% | 85.0% | 16 ms | Offline |
| **TurboQuant** | Python Rust (`turbovec`) | 85.0% | 82.5% | 0.018 ms | Offline |
| **TurboQuant** | Pure JS / Python (built-in) | 86.7% | 77.5% | 0.14 ms | Offline |
| *BM25 (Baseline)* | Lexical search | 88.3% | 95.0% | 0.025 ms | Offline |

## End-to-End Agent Architecture Benchmark (60 Tools)

Evaluated with Claude Haiku 4.5 across 60 tool schemas and 79 queries:

| Paradigm | Accuracy | Latency (P50) | Tokens / Turn | Roundtrips | Notes |
|---|---|---|---|---|---|
| **Tool-Prune Direct** | **97.5%** | **149 ms** | **385 tokens** | 0 LLM turns | LLM bypassed via calibrated fast-path (91% of queries) |
| **Tool-Prune + LLM** | **97.5%** | **195 ms** | **397 tokens** | 1 turn | Dynamic Top-K candidate schema pruning (-72% tokens) |
| **Full-Context LLM** | 97.5% | 555 ms | 1,409 tokens | 1 turn | All 60 tool schemas dumped into prompt context |
| **Tool-Search (BM25 + LLM)** | 87.3% | 979 ms | 436 tokens | 2 turns | Lexical retrieval bottleneck on ambiguous queries |
| **Code Mode (`search` + `eval`)** | 64.6% | 2,209 ms | 1,735 tokens | 1.9 turns | Multi-turn discovery drops target before sandbox execution |

Run evaluations:

```bash
node bench/run.mjs --size 60
node bench/run_codemode_eval.mjs
node bench/run_bfcl_eval.mjs
uv run --with turbovec --with numpy python3 bench/run_turbovec_bench.py
```

## License

MIT © [Hemanth.HM](https://h3manth.com)
