# tool-prune

Calibrated tool selection and schema pruning for AI agents. Zero-dependency offline TurboQuant, custom local decision engines, or TypeSafe System One.

```bash
pip install tool-prune

# Optional Rust SIMD acceleration (0.041 ms search)
pip install turbovec numpy

# Optional: TypeSafe API key for cloud reasoning
export TYPESAFE_API_KEY="apikey_..."
```

## Quick start

```python
from tool_prune import prune

tools = {
    "read_file": "Read raw text from local filesystem path",
    "run_query": "Execute SQL queries against database",
    "web_search": "Search public web for documentation or articles"
}

match = prune("what tables exist in the db?", tools)
print(match.tool)       # 'run_query'
print(match.confidence) # 0.815
print(match.engine)     # 'turboquant'
```

`prune()` runs offline via 4-bit PolarQuant + 1024-bit QJL TurboQuant (`0.93 ms` pure stdlib, `0.040 ms` with `turbovec`, 99.0% BFCL v3 Top-1 and 99.0% 100-Tool Top-5 recall across all `N = 200` `BFCL_v3_multiple` queries) by default, or routes to TypeSafe System One when `TYPESAFE_API_KEY` is set. Accepts plain dicts, MCP `inputSchema`, Anthropic `input_schema`, and OpenAI `{ "type": "function", "function": ... }` tool lists.

## Schema pruning for LLMs

```python
from tool_prune import prune

router = prune(mcp_tools)

# Conformal auto-selection (or pass k=5):
top_tools = router.filter(user_prompt, allow_empty=True)

response = llm.chat(
    tools=top_tools,
    messages=[{"role": "user", "content": user_prompt}]
)
```

Cuts prompt schema tokens by up to 98% while preserving your exact SDK tool dicts.

## Fast-path direct dispatch

```python
result = router.dispatch("read ./pyproject.toml", {
    "read_file": lambda q: open("pyproject.toml").read(),
    "run_query": lambda q: db.query(q),
    "fallback": lambda q, m: call_llm(q, m.auto_tools)
})
```

## Pluggable engines

```python
local_match = prune(query, tools, engine="turboquant")
simd_match  = prune(query, tools, engine="turbovec")
cloud_match = prune(query, tools, engine="typesafe", api_key="...")
custom_match = prune(query, tools, engine=decision_engine)
```

- **turboquant**: 100% offline, zero network, zero dependencies (`1.35 ms` pure Python stdlib).
- **turbovec**: Optional Rust SIMD backend (`0.041 ms` kernel latency) sharing the same Corpus-IDF feature pipeline.
- **custom engine**: Any object with `choice({ "state", "question", "options" })` or callable `(query, criteria, kwargs) -> candidates`.
- **typesafe**: Cloud System One reasoning (Jev) with calibrated probabilities.

## Demo

```bash
python examples/quickstart.py
```

## License

MIT © [Hemanth.HM](https://h3manth.com)
