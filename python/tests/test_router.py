import unittest
from tool_prune import ToolPrune, TurboQuantEngine, prune, prune_auto, normalize_tools, auto_select_candidates
from tool_prune.router import CandidateTool, _normalize_tools


class TestToolPrune(unittest.TestCase):
    def test_normalize_dict(self):
        criteria, registry = _normalize_tools({
            "read": "Read file contents",
            "write": {"description": "Write file contents"}
        })
        self.assertEqual(criteria["read"], "Read file contents")
        self.assertEqual(criteria["write"], "Write file contents")
        self.assertEqual(registry["read"]["name"], "read")

    def test_normalize_mcp_anthropic_openai_schemas(self):
        mcp_tool = {
            "name": "postgres_query",
            "description": "Run read-only SQL",
            "inputSchema": {"type": "object", "properties": {"sql": {"type": "string"}}},
        }
        anthropic_tool = {
            "name": "slack_post",
            "description": "Post message",
            "input_schema": {"type": "object", "properties": {"channel": {"type": "string"}}},
        }
        openai_tool = {
            "type": "function",
            "function": {
                "name": "get_exchange_rate",
                "description": "Fetch currency rate",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "base": {"type": "string", "enum": ["USD", "EUR"]},
                        "date": {"type": "string", "description": "Historical ISO date"},
                    },
                },
            },
        }
        criteria, registry = normalize_tools([mcp_tool, anthropic_tool, openai_tool])
        self.assertIn("params: sql", criteria["postgres_query"])
        self.assertIn("params: channel", criteria["slack_post"])
        self.assertIn("params: base, date", criteria["get_exchange_rate"])
        self.assertIs(registry["postgres_query"], mcp_tool)
        self.assertIs(registry["slack_post"], anthropic_tool)
        self.assertIs(registry["get_exchange_rate"], openai_tool)

    def test_instantiation_and_dual_mode_prune(self):
        pruner = prune({"read": "Read file"}, threshold=0.8)
        self.assertIsInstance(pruner, ToolPrune)
        self.assertEqual(pruner.threshold, 0.8)
        self.assertEqual(pruner.top_k, "auto")
        configured = ToolPrune({"read": "Read file"}, top_k=3)
        self.assertEqual(configured.top_k, 3)

    def test_default_turboquant_without_api_key(self):
        pruner = ToolPrune({
            "read_file": "Read file contents from filesystem",
            "search_web": "Search the web for real-time information"
        }, api_key="")

        res = pruner.select("read package.json")
        self.assertEqual(res.engine, "turboquant")
        self.assertEqual(res.tool, "read_file")
        self.assertGreater(res.confidence, 0.5)
        self.assertEqual(len(res.top_k), 2)
        self.assertGreaterEqual(len(res.auto_selected), 1)

    def test_missing_api_key_when_typesafe_requested(self):
        pruner = ToolPrune({"read": "Read file"}, api_key="")
        with self.assertRaises(ValueError):
            pruner.select("read something", engine="typesafe")

    def test_negation_uri_and_temporal_literals(self):
        tools = {
            "git_diff_unstaged": "View diffs of changes in working directory that are not yet staged",
            "git_diff_staged": "View diffs of changes added to git staging index ready to commit",
            "http_get_request": "Perform HTTP GET request to remote REST endpoint URL",
            "github_create_pr": "Open a new pull request on GitHub repository",
            "rate_latest": {
                "description": "Get latest exchange rate",
                "inputSchema": {"properties": {"from": {"type": "string"}, "to": {"type": "string"}}},
            },
            "rate_historical": {
                "description": "Get exchange rate on a specific date",
                "inputSchema": {"properties": {"from": {"type": "string"}, "to": {"type": "string"}, "date": {"type": "string"}}},
            },
        }
        router = ToolPrune(tools, engine="turboquant")
        self.assertEqual(router.select("show the diff of changes I haven't staged yet").tool, "git_diff_unstaged")
        self.assertEqual(router.select("show me what's currently in git staging ready to commit").tool, "git_diff_staged")
        self.assertEqual(router.select("query GET https://status.github.com/api/v2/summary.json").tool, "http_get_request")
        self.assertEqual(router.select("Find conversion rate from Euro to Dollar on January 1, 2022").tool, "rate_historical")

    def test_allow_empty_ood_rejection_and_kwargs_forwarding(self):
        tools = {
            "fs_read_file": "Read raw text contents of a local file from disk",
            "db_query_select": "Execute read-only SQL SELECT query against database",
        }
        res = prune("hello, how are you today?", tools, engine="turboquant", allow_empty=True)
        self.assertEqual(res.tool, "")
        self.assertEqual(len(res.auto_tools), 0)
        self.assertLess(res.confidence, 0.2)

    def test_custom_decision_engine(self):
        class MockEngine:
            name = "webml-mock"
            def choice(self, payload):
                assert payload["state"] == "run sql on users"
                return {
                    "choice": "run_sql",
                    "confidence": 0.94,
                    "probabilities": {"run_sql": 0.94, "read_file": 0.06},
                }

        router = ToolPrune({"run_sql": "Execute SQL", "read_file": "Read file"}, engine=MockEngine())
        res = router.select("run sql on users")
        self.assertEqual(res.engine, "webml-mock")
        self.assertEqual(res.tool, "run_sql")
        self.assertAlmostEqual(res.confidence, 0.94)
        self.assertEqual(len(res.auto_tools), 1)

    def test_filter_with_turboquant(self):
        tools = {
            "git_commit": "Record changes to the repository",
            "git_push": "Update remote refs along with associated objects",
            "file_search": "Search for files by name glob",
            "text_replace": "Replace text inside a file"
        }
        pruner = ToolPrune(tools, engine="turboquant")
        pruned = pruner.filter("commit these changes with a message", k=2)
        self.assertEqual(len(pruned), 2)
        self.assertEqual(pruned[0]["name"], "git_commit")

    def test_dispatch_with_turboquant(self):
        tools = {
            "calculator": "Calculate mathematical expressions",
            "weather": "Get current weather forecast"
        }
        pruner = ToolPrune(tools, engine="turboquant", threshold=0.1)
        executed = False
        def calc_handler(query, selection):
            nonlocal executed
            executed = True
            return {"answer": 4, "tool": selection.tool}

        result = pruner.dispatch("calculate 2 + 2", handlers={"calculator": calc_handler})
        self.assertTrue(executed)
        self.assertEqual(result["answer"], 4)

    def test_one_shot_prune(self):
        tools = {
            "get_weather": "Get weather for a city",
            "send_email": "Send an email message"
        }
        res = prune("what's the weather in tokyo", tools, engine="turboquant")
        self.assertEqual(res.engine, "turboquant")
        self.assertEqual(res.tool, "get_weather")

    def test_auto_select_candidates_dominant(self):
        candidates = [
            CandidateTool(name="git_commit", score=0.65, probability=0.95),
            CandidateTool(name="git_status", score=0.20, probability=0.70),
            CandidateTool(name="fs_read", score=0.12, probability=0.60)
        ]
        selected = auto_select_candidates(candidates)
        self.assertEqual(len(selected), 1)
        self.assertEqual(selected[0].name, "git_commit")

    def test_auto_select_candidates_cluster(self):
        candidates = [
            CandidateTool(name="git_diff", score=0.42, probability=0.85),
            CandidateTool(name="git_status", score=0.38, probability=0.82),
            CandidateTool(name="fs_read", score=0.10, probability=0.40)
        ]
        selected = auto_select_candidates(candidates)
        self.assertEqual(len(selected), 2)
        self.assertEqual(selected[0].name, "git_diff")
        self.assertEqual(selected[1].name, "git_status")

    def test_filter_auto_mode(self):
        tools = {
            "git_commit": "Record changes to the repository with a commit message",
            "git_status": "Show working tree status and untracked files",
            "calculator": "Evaluate mathematical expressions",
            "weather": "Get current weather forecast"
        }
        pruner = ToolPrune(tools, engine="turboquant")
        auto_pruned = pruner.filter("commit changes with fix")
        self.assertIsInstance(auto_pruned, list)
        self.assertGreaterEqual(len(auto_pruned), 1)
        self.assertLessEqual(len(auto_pruned), 2)
        self.assertEqual(auto_pruned[0]["name"], "git_commit")

        explicit_auto = pruner.filter("commit changes with fix", k="auto")
        self.assertEqual(auto_pruned, explicit_auto)

        auto_method = pruner.auto("commit changes with fix")
        self.assertEqual(auto_pruned, auto_method)

    def test_prune_auto_one_shot(self):
        tools = {
            "git_commit": "Record changes to the repository with a commit message",
            "weather": "Get current weather forecast"
        }
        selected = prune_auto("commit changes", tools, engine="turboquant")
        self.assertIsInstance(selected, list)
        self.assertEqual(selected[0]["name"], "git_commit")

        selected_via_attr = prune.auto("commit changes", tools, engine="turboquant")
        self.assertEqual(selected, selected_via_attr)

    def test_turboquant_direct_engine(self):
        tq = TurboQuantEngine()
        tq.fit({"alpha": "Compute eigenvalues", "beta": "Send Slack alert"})
        res = tq.search("eigenvalues of matrix", top_k=2)
        self.assertEqual(res[0]["name"], "alpha")
        self.assertGreater(res[0]["score"], res[1]["score"])

    def test_turbovec_engine_or_fallback(self):
        tools = {
            "alpha": "Compute matrix eigenvalues and eigenvectors",
            "beta": "Send Slack alert message to channel",
        }
        pruner = ToolPrune(tools, engine="turbovec")
        res = pruner.select("eigenvalues of matrix")
        self.assertEqual(res.tool, "alpha")

    def test_dispatch_single_arg_handler(self):
        tools = {
            "read_file": "Read raw text from local filesystem path",
            "run_query": "Execute SQL queries against database",
        }
        router = ToolPrune(tools, threshold=0.5, engine="turboquant")
        out = router.dispatch("read package.json from local filesystem", {
            "read_file": lambda q: f"handled:{q}",
            "fallback": lambda q: f"fallback:{q}",
        })
        self.assertEqual(out, "handled:read package.json from local filesystem")


if __name__ == "__main__":
    unittest.main()
