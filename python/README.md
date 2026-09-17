# tool-prune

Calibrated tool selection and schema pruning for AI agents. Dual-engine: zero-dependency offline TurboQuant or TypeSafe System One.

```bash
pip install tool-prune

# Optional SIMD acceleration
pip install turbovec

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

# Works offline out of the box with TurboQuant:
match = prune("what tables exist in the db?", tools)
print(match.tool)   # 'run_query'
print(match.engine) # 'turboquant'
```

`prune()` narrows schemas offline via TurboQuant by default, or routes to TypeSafe System One when `TYPESAFE_API_KEY` is present. That's the whole API.

## Schema pruning for LLMs

```python
from tool_prune import ToolPrune

router = ToolPrune(tools)
top_tools = router.filter(user_prompt, k=5)

response = llm.chat(
    tools=top_tools,
    messages=[{"role": "user", "content": user_prompt}]
)
```

Cuts prompt tokens by up to 92% and eliminates context confusion without losing tools.

## Fast-path direct dispatch

```python
result = router.dispatch("read ./pyproject.toml", {
    "read_file": lambda q, m: open("pyproject.toml").read(),
    "run_query": lambda q, m: db.query(q),
    "fallback": lambda q, m: call_llm(q)
})
```

Runs deterministic handlers in under 160ms with zero token cost.

## Dual engine

```python
local_match = prune(query, tools, engine="turboquant")
cloud_match = prune(query, tools, engine="typesafe", api_key="...")
```

- **turboquant**: 100% offline, zero network, zero dependencies. Uses `turbovec` (Rust SIMD) if installed, with built-in FWHT fallback.
- **typesafe**: Cloud System One reasoning (Jev). 100% Top-1 accuracy on subtle distractors with calibrated probabilities.

## Demo

```bash
python examples/quickstart.py
```

## License

MIT © [Hemanth.HM](https://h3manth.com)
