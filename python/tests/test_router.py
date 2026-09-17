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

    def test_missing_api_key(self):
        pruner = ToolPrune({"read": "Read file"}, api_key="")
        pruner.api_key = None
        with self.assertRaises(ValueError):
            pruner.select("read something")

if __name__ == "__main__":
    unittest.main()
