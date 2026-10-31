# tool-prune

Calibrated tool selection and schema pruning for AI agents. Zero-dependency offline TurboQuant, on-device WebGPU/WASM engines, or TypeSafe System One.

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
console.log(match.tool);       // 'runQuery'
console.log(match.confidence); // 0.815
console.log(match.engine);     // 'turboquant'
```

`prune()` runs offline via TurboQuant by default, or routes to TypeSafe System One when `TYPESAFE_API_KEY` is present. Accepts plain dictionaries, MCP `inputSchema` objects, Anthropic `input_schema` tools, and OpenAI `{ type: 'function', function }` arrays while returning your original tool objects unchanged.

## Schema pruning for LLMs

Prune large MCP or SDK tool catalogs down to the relevant candidates before calling your LLM:

```js
const router = prune(mcpTools);

// Conformal auto-selection based on score distribution (or pass { k: 5 }):
const topTools = await router.filter(userPrompt, { allowEmpty: true });

const response = await llm.chat({
  tools: topTools,
  messages: [{ role: 'user', content: userPrompt }]
});
```

`filter()` selects candidate tools dynamically using uncertainty-aware drop-off, cutting prompt schema tokens by up to 98% while preserving 100% Top-5 recall on BFCL v3. Pass `{ allowEmpty: true }` to return `[]` on out-of-domain chat prompts.

## Fast-path direct dispatch

Bypass the LLM when confidence clears your threshold:

```js
const result = await router.dispatch('read ./package.json', {
  readFile: (query) => fs.readFileSync('package.json', 'utf8'),
  runQuery: (query) => db.query(query),
  fallback: (query, match) => callLLM(query, match.autoTools)
});
```

## Pluggable engines

Switch between offline 4-bit PolarQuant + QJL vector search, on-device decision models (`webml-kit`), or cloud System One:

```js
const localMatch = await prune(query, tools, { engine: 'turboquant' });
const cloudMatch = await prune(query, tools, { engine: 'typesafe', apiKey: '...' });
const onDevice   = await prune(query, tools, { engine: decisionEngine });
```

- **turboquant**: 100% offline, zero network, zero dependencies. Corpus-IDF Count-Sketch + FWHT + 4-bit PolarQuant + 1024-bit QJL residual correction (`0.18 ms` in JS, `0.041 ms` with optional `turbovec` Rust SIMD in Python).
- **custom `.choice()` / function**: Pass any on-device engine implementing `choice({ state, question, options })` (such as `webml-kit`) or `(query, criteria) => candidates`.
- **typesafe**: Cloud System One reasoning (Jev) with calibrated probabilities and `requiresGeneration` scoring.

## Python

Identical API and zero required dependencies:

```python
from tool_prune import prune

# One-shot offline selection
match = prune("what tables exist in the db?", tools)
print(match.tool, round(match.confidence, 3))

# Reusable router for LLM prompt pruning
router = prune(tools)
candidates = router.filter(user_prompt, allow_empty=True)
```

## Berkeley Function Calling Leaderboard (BFCL v3)

Evaluated on Gorilla BFCL v3 multiple-tool benchmark:

| Engine | Backend | Distractor Top-1 | 100-Tool Top-5 Prune | Latency | Network |
|---|---|---|---|---|---|
| **TypeSafe (Jev)** | Cloud System One | **100.0%** | **100.0%** | 189 ms | Cloud API |
| **TurboQuant** | Python Rust (`turbovec`) | **100.0%** | **100.0%** | 0.041 ms | Offline |
| **TurboQuant** | Pure JS (built-in) | **100.0%** | **100.0%** | 0.18 ms | Offline |
| **TurboQuant** | Pure Python (stdlib) | **100.0%** | **100.0%** | 1.35 ms | Offline |
| *BM25 (Baseline)* | Lexical search | 88.3% | 95.0% | 1.30 ms | Offline |

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
node bench/run_bfcl_eval.mjs
node bench/run_tqs_eval.mjs --size 60
uv run --with turbovec --with numpy python3 bench/run_turbovec_bench.py
```

## License

MIT © [Hemanth.HM](https://h3manth.com)
