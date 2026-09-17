import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from tool_prune import ToolPrune

api_key = os.getenv("TYPESAFE_API_KEY")
if not api_key:
    print("Error: TYPESAFE_API_KEY environment variable is required.")
    sys.exit(1)

tools = {
    "readFile": "Read raw text from local file path",
    "runQuery": "Execute SQL queries against connected database",
    "webSearch": "Search public web for documentation or articles",
    "gitStatus": "Check git working tree status and modified files"
}

pruner = ToolPrune(tools, api_key=api_key)

print("--- 1. Select Tool ---")
res = pruner.select("show me modified files in repo")
print(f"Tool: {res.tool} (confidence: {res.confidence}, probability: {res.probability}, latency: {res.latency_ms:.1f}ms)")

print("\n--- 2. Prune Top-2 Candidates for LLM Prompt ---")
top2 = pruner.filter("what columns are in the users table?", k=2)
print("Pruned candidate schemas:", top2)

print("\n--- 3. Direct Dispatch ---")
output = pruner.dispatch("find latest news on TC39", {
    "webSearch": lambda q, s: f"[Executed webSearch for: '{q}']",
    "runQuery": lambda q, s: f"[Executed SQL query: '{q}']",
    "fallback": lambda q, s: f"[Escalated to LLM: '{q}']"
})
print("Dispatch output:", output)
