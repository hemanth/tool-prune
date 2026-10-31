import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from tool_prune import prune

tools = {
    "readFile": "Read raw text from local file path",
    "runQuery": "Execute read-only SQL SELECT queries against database tables and columns",
    "webSearch": "Search public web for documentation, articles, or news",
    "gitStatus": "Check git working tree status and modified files in repository",
}

# Uses offline TurboQuant automatically, or TypeSafe System One if TYPESAFE_API_KEY is set
pruner = prune(tools)

print("--- 1. Select Tool ---")
res = pruner.select("show me modified files in repo")
print(f"Tool: {res.tool} (engine: {res.engine}, confidence: {res.confidence:.3f}, latency: {res.latency_ms:.2f}ms)")

print("\n--- 2. Adaptive Conformal Prune for LLM Prompt ---")
candidates = pruner.filter("select email from users table")
print("Pruned candidate schemas:", candidates)

print("\n--- 3. Direct Dispatch ---")
output = pruner.dispatch("search public web for latest TC39 news", {
    "webSearch": lambda q, s: f"[Executed webSearch for: '{q}']",
    "runQuery": lambda q, s: f"[Executed SQL query: '{q}']",
    "fallback": lambda q, s: f"[Escalated to LLM: '{q}']",
})
print("Dispatch output:", output)
