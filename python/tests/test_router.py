import unittest
from tool_prune import ToolPrune, prune
from tool_prune.router import _normalize_tools

class TestToolPrune(unittest.TestCase):
    def test_normalize_dict(self):
        criteria, registry = _normalize_tools({
            "read": "Read file contents",
            "write": {"description": "Write file contents"}
        })
        self.assertEqual(criteria["read"], "Read file contents")
        self.assertEqual(criteria["write"], "Write file contents")
        self.assertEqual(registry["read"]["name"], "read")

    def test_normalize_list(self):
        criteria, registry = _normalize_tools([
            {"name": "read", "description": "Read file"},
            {"id": "write", "criteria": "Write file"}
        ])
        self.assertEqual(criteria["read"], "Read file")
        self.assertEqual(criteria["write"], "Write file")
        self.assertEqual(registry["read"]["name"], "read")

    def test_instantiation(self):
        pruner = ToolPrune({"read": "Read file"})
        self.assertEqual(pruner.threshold, 0.85)
        self.assertEqual(pruner.top_k, "auto")
        configured = ToolPrune({"read": "Read file"}, top_k=3)
        self.assertEqual(configured.top_k, 3)

    def test_default_turboquant_without_api_key(self):
        pruner = ToolPrune({
            "read_file": "Read file contents from filesystem",
            "search_web": "Search the web for real-time information"
        }, api_key="")
        pruner.api_key = None

        res = pruner.select("read package.json")
        self.assertEqual(res.engine, "turboquant")
        self.assertEqual(res.tool, "read_file")
        self.assertGreater(res.confidence, 0.0)
        self.assertEqual(len(res.top_k), 2)
        self.assertGreaterEqual(len(res.auto_selected), 1)

    def test_missing_api_key_when_typesafe_requested(self):
        pruner = ToolPrune({"read": "Read file"}, api_key="")
        pruner.api_key = None
        with self.assertRaises(ValueError):
            pruner.select("read something", engine="typesafe")

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
        from tool_prune.router import CandidateTool, auto_select_candidates
        candidates = [
            CandidateTool(name="git_commit", score=0.65, probability=0.95),
            CandidateTool(name="git_status", score=0.20, probability=0.70),
            CandidateTool(name="fs_read", score=0.12, probability=0.60)
        ]
        selected = auto_select_candidates(candidates)
        self.assertEqual(len(selected), 1)
        self.assertEqual(selected[0].name, "git_commit")

    def test_auto_select_candidates_cluster(self):
        from tool_prune.router import CandidateTool, auto_select_candidates
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
        from tool_prune import prune_auto
        selected = prune_auto("commit changes", tools, engine="turboquant")
        self.assertIsInstance(selected, list)
        self.assertEqual(selected[0]["name"], "git_commit")

        selected_via_attr = prune.auto("commit changes", tools, engine="turboquant")
        self.assertEqual(selected, selected_via_attr)

if __name__ == "__main__":
    unittest.main()

