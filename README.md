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

`filter()` selects candidate tools dynamically using uncertainty-aware drop-off, cutting prompt schema tokens by up to 98% while preserving 99.0%–100.0% Top-5 recall across all 200 BFCL v3 `multiple` queries. Pass `{ allowEmpty: true }` to return `[]` on out-of-domain chat prompts.

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

## BFCL v3 Tool Retrieval & Schema Pruning (`N = 200`)

Evaluated across all `200` queries and `443` unique tool schemas of the Gorilla `BFCL_v3_multiple` dataset (measuring tool-name retrieval and candidate recall prior to LLM argument generation, against a pre-indexed `camelCase`/`snake_case`-splitting BM25 baseline):

| Engine | Backend | Distractor Top-1 (`2–4`) | 100-Tool Top-5 | 443-Tool Top-5 | 100-Tool Latency | Network |
|---|---|---|---|---|---|---|
| **TypeSafe (Jev)** | Cloud System One | **99.5%** | **100.0%** | **99.5%** | 84 ms | Cloud API |
| **TurboQuant** | Python Rust (`turbovec`) | **99.0%** | **99.0%** | **97.5%** | 0.040 ms (`0.16 ms` E2E) | Offline |
| **TurboQuant** | Pure JS (built-in) | **99.0%** | **99.0%** | **96.5%** | 0.11 ms | Offline |
| **TurboQuant** | Pure Python (stdlib) | **99.0%** | **99.0%** | **97.0%** | 0.93 ms | Offline |
| *BM25 (Baseline)* | Identifier-split lexical | 94.5% | 97.5% | 93.5% | 0.04 ms | Offline |

## End-to-End Agent Architecture Benchmark (60 Tools, 79 Queries)

Evaluated with Claude Haiku 5.5 (`claude-haiku-5-5`, $B=1,000$ bootstrap 95% CIs in `bench/results.json`):

| Paradigm | Accuracy (95% CI) | Latency (P50) | Tokens / Turn | Roundtrips | Notes |
|---|---|---|---|---|---|
| **Tool-Prune Direct** | **97.5%** `[93.7, 100]` | **105 ms** | **397 tokens** | 0 LLM turns | Calibrated fast-path bypasses LLM on 93.7% of queries |
| **Tool-Prune + LLM** | **97.5%** `[93.7, 100]` | 777 ms | 581 tokens | 1 turn | Jev Top-3 schema pruning (100% recall, -71% tokens) |
| **TurboQuant + LLM** | 93.7% `[88.6, 98.7]` | **650 ms** | **270 tokens** | 1 turn | Zero-dep offline Top-5 pruning (-87% tokens, 0 API keys) |
| **Full-Context LLM** | 97.5% `[93.7, 100]` | 683 ms | 2,026 tokens | 1 turn | All 60 tool schemas sent in every prompt |
| **Tool-Search (BM25 + LLM)** | 93.7% `[88.6, 98.7]` | 1,185 ms | 469 tokens | 2 turns | Two-turn lexical discovery doubles latency |
| **Code Mode (`search` + `eval`)** | 57.0% | 1,530 ms | 1,565 tokens | 1.9 turns | Keyword discovery drops target before sandbox execution |

### Multi-Model Generalization (Accuracy / P50 Latency)

| Model | Full-Context (60 Tools) | Offline TurboQuant + LLM | Tool-Prune + LLM | Tool-Prune Direct | Code Mode |
|---|---|---|---|---|---|
| **Claude Opus 5.5** | 97.5% (1,106 ms) | 93.7% (1,106 ms) | **97.5%** (1,502 ms) | **97.5% (105 ms)** | 74.7% (3,360 ms) |
| **Claude Sonnet 5.5** | 97.5% (843 ms) | 93.7% (854 ms) | **97.5%** (989 ms) | **97.5% (105 ms)** | 50.6% (1,986 ms) |
| **Claude Fable 5.2** | 97.5% (2,643 ms) | 93.7% (1,804 ms) | 96.2% (3,008 ms) | **97.5% (105 ms)** | 50.6% (4,529 ms) |
| **Claude Haiku 5.5** | 97.5% (683 ms) | 93.7% (650 ms) | **97.5%** (777 ms) | **97.5% (105 ms)** | 57.0% (1,530 ms) |
| **Gemini 4 Carbon** | 97.5% (7,575 ms) | 92.4% (7,415 ms) | 96.2% (5,333 ms) | **97.5% (100 ms)** | 62.0% (102,403 ms) |
| **Gemini 4 Argon** | 97.5% (3,785 ms) | 92.4% (3,676 ms) | 96.2% (4,121 ms) | **97.5% (100 ms)** | 87.3% (16,636 ms) |
| **Gemma 3 1B (Local)** | 15.2% (353 ms) | **68.4% (252 ms)** | **87.3% (359 ms)** | **96.2% (105 ms)** | N/A |

Run evaluations:

```bash
node bench/run_bfcl_eval.mjs
node bench/run.mjs --size 60 --models claude-haiku-5-5,claude-sonnet-5-5,claude-opus-5-5,claude-fable-5-2,gemini-4-argon,gemini-4-carbon,ollama:gemma3:1b
node bench/run_codemode_eval.mjs --models claude-haiku-5-5,claude-sonnet-5-5,claude-opus-5-5,claude-fable-5-2,gemini-4-argon,gemini-4-carbon
```

## License

MIT © [Hemanth.HM](https://h3manth.com)
