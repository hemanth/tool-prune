# Claude Code Code Mode vs tool-prune

Measured 2026-11-15 on Claude Code 2.1.325 with `claude-sonnet-5-5` and `claude-opus-5-5`, using this repo's 60-tool catalog and 79 queries. One run per query per setup. Sonnet: 632 sessions across eight setups, $31.27 of Anthropic API usage including 47 sessions that had to be re-run. Opus: 478 sessions across six setups, $28.40.

## Summary

- **tool-prune with the TypeSafe Jev engine matched stock Claude Code; Code Mode and offline TurboQuant trailed slightly.** Stock Claude Code and Jev Top-3 pruning both picked the right tool on 96.2% of queries. Code Mode and TurboQuant Top-5 pruning both scored 92.4%. The confidence intervals overlap, so none of these gaps is statistically separated at N=79.
- **Jev direct dispatch was the only setup that changed cost and latency by an order of magnitude.** It routed 93.7% of queries with no Claude Code session at all (121 ms p50 against 6.6 s) and scored 97.5% overall. It only selects the tool; it does not produce arguments.
- **At 443 tools, tool-prune did improve Claude Code on cost and prompt size, though not on accuracy.** With the BFCL pool and real schemas, Jev Top-5 pruning halved the cost per task ($0.022 against $0.042) and cut prompt tokens by 26% at the same accuracy and speed. See the 443-tool section below; the 60-tool findings follow.
- **On Opus 5.5, Code Mode's accuracy gap disappeared but its extra round-trips did not.** Code Mode matched stock Claude Code at 96.2% on Opus, with 4.5 model requests per task against 2.9. See the Opus section below; the rest of this summary describes the Sonnet 5.5 run.
- **Code Mode costs more round-trips.** It averaged 4.2 model requests per task against 2.9 for ordinary tools, with a p50 turn of 7.8 s against 6.6 s. It has the smallest starting prompt (16.4k tokens vs 21.2k).
- **Pruning saves schema tokens only when schemas are sent upfront.** Stock Claude Code already defers MCP schemas behind its own ToolSearch, so pruning changed the prompt by almost nothing there. With deferral turned off, pruning cut about 7,000 prompt tokens per request (46.9k to 40.2k for Top-5, 39.9k for Top-3).
- **Per-query pruning broke prompt caching in the upfront setup.** Cache writes rose from 10.1k to about 36k tokens per task, and cost per task rose from $0.041 to about $0.10, for both engines.
- **The approaches fail differently.** Code Mode's unique misses were all on tools that duplicate Claude Code built-ins. TurboQuant's unique misses were retrieval misses (target in the Top-5 for 94.5% of queries). Jev had no retrieval misses (100% Top-3 recall).
- **The README's existing "Code Mode" row is a different thing.** It is this repo's own `search_tools` + `execute_code` simulation (50.6% on Sonnet 5.5), not Claude Code's Code Mode. The two numbers are not comparable, because the harness and scoring differ.

## Results (Sonnet 5.5)

| Setup | Accuracy (95% CI) | Model requests / task | Starting prompt | Prompt with catalog loaded | Prompt tokens / task | p50 turn | Cost / task |
|---|---|---|---|---|---|---|---|
| Stock Claude Code (ToolSearch deferral) | 96.2% `[92.4, 100]` | 2.95 | 21,169 | 23,719 | 70,315 | 6,559 ms | $0.029 |
| Schemas upfront (`ENABLE_TOOL_SEARCH=false`) | 94.9% `[89.9, 98.7]` | 2.82 | 39,492 | 46,897 | 125,064 | 7,284 ms | $0.041 |
| tool-prune Top-5, schemas upfront | 92.4% `[86.1, 97.5]` | 2.80 | 39,492 | 40,182 | 111,810 | 6,696 ms | $0.101 |
| tool-prune Top-5, deferred | 92.4% `[86.1, 97.5]` | 2.90 | 21,169 | 25,047 | 70,726 | 5,612 ms | $0.032 |
| tool-prune Jev Top-3, schemas upfront | 93.7% `[88.6, 98.7]` | 2.80 | 39,492 | 39,940 | 111,363 | 7,997 ms | $0.104 |
| tool-prune Jev Top-3, deferred | 96.2% `[92.4, 100]` | 2.89 | 21,169 | 24,940 | 70,254 | 6,161 ms | $0.032 |
| tool-prune Jev direct dispatch | 97.5% `[93.7, 100]` | 0.22 | n/a | n/a | 5,206 | 121 ms | $0.002 |
| Code Mode | 92.4% `[86.1, 97.5]` | 4.23 | 16,388 | 20,745 | 87,349 | 7,796 ms | $0.038 |
| Code Mode + tool-prune Top-5 | 91.1% `[84.8, 96.2]` | 4.25 | 16,388 | 20,726 | 83,992 | 8,119 ms | $0.020 |

- **Accuracy** means the target catalog tool was called; for the 6 out-of-domain queries it means no catalog tool was called. All setups scored 100% on out-of-domain queries.
- **Prompt with catalog loaded** is the median size of the second request, taken over in-domain sessions that called a tool. The first request goes out before the MCP server's tools are visible in every setup.
- **Jev direct dispatch** uses Jev's choice with no Claude Code session when its confidence is at least 0.85 (93.7% of queries, 97.3% correct), and falls back to the deferred Jev session otherwise. Its figures are derived from the Jev retrieval results and the deferred Jev sessions, not from separate sessions. Its cost column covers Anthropic usage only; TypeSafe API charges are not included.
- **Jev retrieval** on the 73 in-domain queries: 94.5% Top-1, 100% Top-3 recall, 119 ms p50.
- **Cost / task** is confounded by cache warmth and run order (the last arm ran against a warm cache), so treat it as indicative. The upfront-pruning cost jump is the exception: it follows directly from the measured cache writes.

### Accuracy by slice

| Setup | Direct | Overlapping tools | Domains Claude Code has built-ins for | External-service domains |
|---|---|---|---|---|
| Stock Claude Code | 97.8% | 92.6% | 92.3% | 100% |
| Schemas upfront | 97.8% | 88.9% | 92.3% | 97.1% |
| tool-prune TurboQuant, upfront | 95.7% | 85.2% | 84.6% | 100% |
| tool-prune TurboQuant, deferred | 95.7% | 85.2% | 84.6% | 100% |
| tool-prune Jev, upfront | 95.7% | 88.9% | 89.7% | 97.1% |
| tool-prune Jev, deferred | 97.8% | 92.6% | 92.3% | 100% |
| tool-prune Jev direct dispatch | 100% | 92.6% | 94.9% | 100% |
| Code Mode | 93.5% | 88.9% | 84.6% | 100% |
| Code Mode + tool-prune | 93.5% | 85.2% | 82.1% | 100% |

"Built-in" domains are filesystem, code, git, web, process and system (39 queries). External domains are database, docker, cloud, network, security, communication and the rest (34 queries).

## Results (Opus 5.5)

Same harness, queries and Claude Code version, with `claude-opus-5-5` (478 sessions, $28.40).

| Setup | Accuracy (95% CI) | Model requests / task | Prompt tokens / task | p50 turn | Cost / task |
|---|---|---|---|---|---|
| Stock Claude Code (ToolSearch deferral) | 96.2% `[92.4, 100]` | 2.86 | 66,529 | 5,277 ms | $0.054 |
| Schemas upfront (`ENABLE_TOOL_SEARCH=false`) | 94.9% `[89.9, 98.7]` | 2.82 | 125,277 | 5,329 ms | $0.075 |
| tool-prune TurboQuant Top-5, deferred | 92.4% `[86.1, 97.5]` | 2.87 | 67,811 | 5,153 ms | $0.034 |
| tool-prune Jev Top-3, deferred | 93.7% `[87.3, 98.7]` | 2.84 | 69,036 | 5,439 ms | $0.062 |
| tool-prune Jev direct dispatch | 96.2% `[91.1, 100]` | 0.22 | 5,178 | 121 ms | $0.004 |
| Code Mode | 96.2% `[92.4, 100]` | 4.54 | 91,963 | 7,896 ms | $0.073 |
| Code Mode + TurboQuant Top-5 | 91.1% `[84.8, 96.2]` | 4.49 | 88,487 | 7,625 ms | $0.043 |

- **Code Mode caught up on accuracy.** Its only misses on Opus were the three queries that fail in nearly every setup. The file-read and shell queries it missed on Sonnet were all routed correctly on Opus, in one case after four searches. It averaged 3.6 `REPL` calls per task against 3.2 on Sonnet.
- **Code Mode's latency penalty grew.** Its p50 turn was 7.9 s against 5.3 s for stock, a wider gap than on Sonnet (7.8 s against 6.6 s).
- **TurboQuant's result did not change.** It missed the same retrieval-miss queries on both models, which is expected: a pruned-out tool is out of reach whatever the model.
- **Jev pruning lost two queries it won on Sonnet** (`web_fetch_url` chosen over `web_search_query`, and no call for `http_post_request`), with the target exposed both times. That is model variance on single queries, not retrieval.
- **Direct dispatch is model-independent on the 93.7% it handles**, so its accuracy moves only with the fallback sessions.
- The two "pruned, schemas upfront" setups were not run on Opus. A four-query pilot put them at $0.37 per task, about $24 each, and the caching effect they showed on Sonnet does not depend on the model.

## Large catalog: 443 BFCL tools (Sonnet 5.5)

The 60-tool catalog is small enough that Claude Code's own ToolSearch has nothing to lose. This run uses the 443 unique tools of Gorilla `BFCL_v3_multiple` with their real parameter schemas, on the first 100 of its 200 single-target queries (500 sessions, $34.02). Code Mode was not part of this run.

| Setup | Accuracy (95% CI) | Model requests / task | First prompt | Prompt tokens / task | p50 turn | Cost / task (warm cache) |
|---|---|---|---|---|---|---|
| Stock Claude Code (ToolSearch deferral) | 88% `[82, 95]` | 2.97 | 28,712 | 86,454 | 4,916 ms | $0.042 |
| All 443 schemas upfront | 86% `[79, 93]` | 1.99 | 124,534 | 247,963 | 3,737 ms | $0.037 |
| tool-prune Jev Top-5, deferred | 90% `[84, 96]` | 2.98 | 21,137 | 64,186 | 4,881 ms | $0.022 |
| tool-prune Jev Top-5, schemas upfront | 89% `[83, 95]` | 1.99 | 40,476 | 80,695 | 3,893 ms | $0.108 |
| tool-prune TurboQuant Top-5, schemas upfront | 88% `[82, 94]` | 1.97 | 40,476 | 79,881 | 3,617 ms | $0.108 |

- Turn times for the Jev rows include the Jev call (115 ms p50).
- Cost is the mean over queries 51–100, after the cache had warmed. Over all 100 queries the all-443-upfront row averages $0.061, because its first sessions write a 124k-token prefix.
- Jev retrieval here is TurboQuant Top-200 followed by Jev: 90% Top-1 and 100% Top-5 recall on these 100 queries. TurboQuant alone had the target in its Top-5 for 98.

What this shows:

- **Jev pruning in front of stock Claude Code halved the cost and cut prompt tokens by 26%, at the same accuracy and speed.** Claude Code lists every deferred tool name in each new session, and 443 names cost about 7,500 tokens that are written to the cache every time. Pruning to five tools removes that.
- **Pruned-and-upfront was about 1 s faster than stock** (3.9 s against 4.9 s; faster on 85 of 100 queries), because it skips the ToolSearch round-trip. It cost 2.5 times as much, since a different tool set per query means about 40k tokens of cache writes per task.
- **Sending all 443 schemas upfront was just as fast and, once warm, the cheapest fast option**, but every request carries 124k tokens of schemas. That is the setup pruning is an alternative to when context space matters.
- **Accuracy did not separate.** All five setups land between 86% and 90% with overlapping intervals. Most misses are near-duplicate names in the merged pool (`solve_quadratic` chosen when `solve_quadratic_equation` was labelled), which no retrieval method can resolve.

Two things this run does not show:

- **A long-lived session.** Each query ran in a fresh session. In one long session the deferred-name list is paid once, so the cost saving from pruning would shrink.
- **A working integration.** Claude Code fixes a server's tool list when it connects. Pruning per prompt in real use would need an MCP proxy that changes its tool list on each prompt; the benchmark simulates that by starting a new session per query.

## What Code Mode does

With `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1`, Claude Code sends the model three tools (`REPL`, `Poll`, `advisor`) instead of its usual set. Everything else, including MCP tools, is reached by writing JavaScript inside `REPL`:

```js
await searchTools("git staged diff status", 10)   // discover names and input types
await tools.mcp__catalog__git_diff_staged({})      // call one, or several with Promise.all
```

In the Sonnet run the model used `searchTools` on 91% of tasks and averaged 3.2 `REPL` calls per task. Each `REPL` call is a full model round-trip, which is where the extra requests come from.

Code Mode is designed to pay off when one script does a lot of work (fan-out, loops, chained calls). This benchmark is single-call routing, which is the case where that advantage cannot show.

### Preconditions observed in 2.1.325

Code Mode refused to start until all of these held:

- An interactive terminal. `claude -p` prints "for now it only works in the interactive terminal" and falls back.
- No installed plugin with JavaScript hooks that check tool calls.
- No `--tools`, `--disallowedTools`, `--restricted`, or deny rule that removes its tools.
- Opus 5.5, Sonnet 5.5 or a later model, on the Anthropic API.
- A one-time opt-in dialog, saved in `.claude.json`.

The binary lists further refusal reasons that were not exercised here, including API key helpers, OpenTelemetry, agent teams, Remote Control, background sessions, and HIPAA or zero-data-retention organizations.

## Where each one failed (Sonnet 5.5)

Three queries failed in almost every setup and say more about the benchmark than the approach:

- `search for where fetchUserData is called` is labelled `code_grep_search`; every setup chose `code_find_references`.
- `run prettier on the codebase` is labelled `code_run_linter`; every setup chose `code_format_buffer`.
- `save this markdown content to docs/intro.md` has no content, so every setup asked for it instead of calling a tool.

**Code Mode's unique misses (3):** `read the package.json file`, `run npm install --legacy-peer-deps in terminal`, `execute ls -la in the terminal`. In each, one `searchTools` call returned built-in tools (file read, shell) and no catalog tool, and the model stopped because the instruction limited it to the catalog. `searchTools` ranks built-ins and MCP tools together, whereas the ordinary ToolSearch only covers the deferred MCP tools.

**TurboQuant's unique misses (3–4):** `what files have I changed so far?` (`git_status`), `look up the current weather in Tokyo online` (`web_search_query`), `find the word config.json inside all files` (`code_grep_search`), plus the prettier query. The target was outside TurboQuant's Top-5 in each; the target was exposed for 94.5% of in-domain queries. Once a tool is pruned out, the model has no way to recover it.

**Jev pruning:** no retrieval misses. The deferred Jev arm failed only the three shared queries above. The upfront Jev arm also missed `env_get_variable` (no call) and chose `k8s_get_pods` over `k8s_describe_pod`, with the target exposed both times. Direct dispatch got the `fs_write_file` query right because it does not stop to ask for the missing content; its two misses were the two ambiguously labelled queries.

## How they relate

- **Stock Claude Code** handles large catalogs by deferring MCP tool schemas and letting the model search for them. This is the baseline both approaches have to beat inside Claude Code, and neither did here.
- **Code Mode** changes how tools are called. The model still discovers tools itself, at the cost of extra round-trips for single calls.
- **tool-prune as a pruner** changes which tools are offered, before the model runs. Inside Claude Code that bought nothing measurable: with deferral on there are no schema tokens to save, and with deferral off the token saving was outweighed by lost prompt caching. Its benefit is in harnesses that send every schema on every request, which is what the README's Messages API benchmarks measure.
- **tool-prune as a router** (Jev direct dispatch) skips the agent for requests it is confident about. Neither Claude Code mode has an equivalent, and it is where the large latency and cost difference came from.
- **Combining Code Mode with pruning** added nothing: Code Mode already hides schemas, so TurboQuant pruning only removed candidates (91.1%). Code Mode with Jev pruning was not run.

## Limits of this measurement

- Two models, one run per query each, N=79. Differences of one to three queries are within noise.
- The stub tools have a one-argument schema, about 120 tokens each. Real MCP schemas are several times larger, which would widen the upfront-vs-pruned gap.
- Every setup had the same appended instruction telling the model to use only catalog operations. Without it the model answered git and file requests with its own Bash tool and never touched the catalog. This instruction works against Code Mode on the 39 queries whose tools duplicate built-ins.
- Argument quality was not scored, only which tool was called. This flatters direct dispatch, which never produces arguments.
- The `claude` binary was reinstalled (same version) during the deferred Jev arm, so 47 of its sessions failed to launch and were re-run afterwards. All scored sessions ran on 2.1.325.

## Reproducing

```bash
export CC_BENCH_CONFIG_DIR=/tmp/cmbench/cfg    # isolated CLAUDE_CONFIG_DIR
export CC_BENCH_WORKDIR=/tmp/cmbench/work      # empty git repo

# One-time, by hand: finish onboarding and trust the folder, then accept the Code Mode opt-in.
cd $CC_BENCH_WORKDIR && CLAUDE_CONFIG_DIR=$CC_BENCH_CONFIG_DIR claude
cd $CC_BENCH_WORKDIR && CLAUDE_CONFIG_DIR=$CC_BENCH_CONFIG_DIR CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1 claude

node bench/run_claude_code_eval.mjs --model claude-sonnet-5-5

# Jev arms (needs TYPESAFE_API_KEY in the environment)
node bench/run_claude_code_eval.mjs --arms jev,jev-upfront,jev-direct

# 443-tool BFCL pool
node bench/run_claude_code_eval.mjs --dataset bfcl --limit 100 --save --jev-k 5 --k 5 \
  --arms default,upfront,jev,jev-upfront,toolprune-upfront
```

- `bench/run_claude_code_eval.mjs` runs the setups and writes `bench/claude_code_codemode_results.json` (60 tools) or `bench/claude_code_bfcl_results.json` (443 tools).
- `bench/pty_session.py` drives each interactive session through a pseudo-terminal.
- `bench/mcp_catalog_server.mjs` is the stub MCP server that logs which catalog tool was called.

Sessions run in `manual` permission mode with only `mcp__catalog` allowed, so a shell or file call would stall on an unanswered prompt instead of running.
