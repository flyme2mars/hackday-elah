"""Planner boundary regression tests; no model services or credentials needed."""
import unittest
from unittest.mock import patch

from sense.planner import Call, OpError, run_command, validate_ops
from sense.test_local_plan import catalog, timeline


class EditOpsTest(unittest.IsolatedAsyncioTestCase):
    async def test_title_commands_reach_host_without_media_search(self):
        ops = [
            {"op": "add_text", "clip_id": "title1", "content": "Hello", "track": "T1", "start_s": 0, "duration_s": 2},
            {"op": "update_text", "clip_id": "title1", "content": "Hi", "start_s": 1, "duration_s": 3, "background": "#000", "background_opacity": 0},
            {"op": "remove", "clip_id": "title1"},
            {"op": "crossfade", "from_clip_id": "c1", "to_clip_id": "c2"},
        ]
        for op in ops:
            with self.subTest(op=op):
                async def planner(contents, messages):
                    return [Call("apply_ops", {"ops": [op]})], contents, messages

                async def choose():
                    return planner

                with patch("sense.planner._choose_planner", choose):
                    result = await run_command(catalog(), {"command": "edit", "timeline": timeline(), "library": []})
                self.assertEqual(result["ops"], [op])
                self.assertEqual(result["hits"], {"video": [], "audio": [], "image": []})

    async def test_title_command_offline_never_invents_edits(self):
        async def choose():
            return None

        with patch("sense.planner._choose_planner", choose):
            result = await run_command(catalog(), {"command": "add title Hello at the start for 2 seconds"})
        self.assertEqual(result["ops"], [])
        self.assertEqual(result["planner"], "offline")

    def test_invalid_text_and_transition_values_are_rejected(self):
        title = {"op": "add_text", "content": "Hello", "start_s": 0, "duration_s": 2}
        for key, value in (("start_s", -1), ("duration_s", 0), ("font_size", -10), ("x", 2), ("y", -1), ("background_opacity", 2), ("content", " ")):
            with self.subTest(key=key):
                with self.assertRaises(OpError):
                    validate_ops([{**title, key: value}], set())
        for op in (
            {"op": "update_text", "clip_id": "title1", "duration_s": -1},
            {"op": "crossfade", "from_clip_id": "a", "to_clip_id": "a"},
            {"op": "crossfade", "from_clip_id": "a", "to_clip_id": "b", "duration_s": 0},
        ):
            with self.subTest(op=op), self.assertRaises(OpError):
                validate_ops([op], set())


if __name__ == "__main__":
    unittest.main()
