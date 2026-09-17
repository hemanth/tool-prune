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
        self.assertEqual(pruner.top_k, 3)

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

if __name__ == "__main__":
    unittest.main()
