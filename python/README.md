# tool-prune

Calibrated tool selection and schema pruning for AI agents. Zero dependencies.

```bash
pip install tool-prune
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
print(match.confidence) # 1.0
```

`prune()` narrows schemas to Top-K candidates or identifies direct matches in ~140ms. `dispatch()` runs immediate tool execution if confidence clears the threshold. That's the whole API.

## Schema pruning for LLMs

```python
from tool_prune import ToolPrune

router = ToolPrune(tools)
top_tools = router.filter(user_prompt, k=3)

response = llm.chat(
    tools=top_tools,
    messages=[{"role": "user", "content": user_prompt}]
)
```

Drops prompt tokens by 75-85% and eliminates context distraction without losing tools.

## Fast-path direct dispatch

```python
result = router.dispatch("read ./pyproject.toml", {
    "read_file": lambda q, m: open("pyproject.toml").read(),
    "run_query": lambda q, m: db.query(q),
    "fallback": lambda q, m: call_llm(q)
})
```

Runs deterministic handlers in under 160ms with zero token cost.

## Config

Set `TYPESAFE_API_KEY` in your environment, or pass options directly:

```python
router = ToolPrune(tools,
    api_key="apikey_...",  # defaults to os.getenv("TYPESAFE_API_KEY")
    threshold=0.85,        # confidence ceiling for fast-path dispatch
    top_k=3                # candidate schemas to retain
)
```

## Demo

```bash
python examples/quickstart.py
```

Runs live quickstart routing with your `TYPESAFE_API_KEY`.

## License

MIT © [Hemanth.HM](https://h3manth.com)
