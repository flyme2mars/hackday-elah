"""Planner boundary regression tests; no model services or credentials needed."""
import unittest
from unittest.mock import patch

from sense.planner import INSTRUCTIONS, TOOLS, Call, OpError, run_command, validate_ops
from sense.test_local_plan import beach_catalog, catalog, timeline


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

    def test_prompt_names_edit_ops_and_degrees(self):
        self.assertIn('{"op":"split","clip_id":"...","at_s":1}', INSTRUCTIONS)
        self.assertIn("Selected clip_ids", INSTRUCTIONS)
        self.assertIn("absolute angle in degrees", INSTRUCTIONS)
        self.assertIn("call apply_ops right away", INSTRUCTIONS)
        apply_ops = next(tool for tool in TOOLS if tool["name"] == "apply_ops")
        search = next(tool for tool in TOOLS if tool["name"] == "search_vault")
        for word in ("trim", "split", "move", "remove", "set_volume", "add_text", "update_text", "crossfade", "set_transform", "add_clip"):
            self.assertIn(word, apply_ops["description"])
        self.assertIn("Do not use this to trim", search["description"])
        turned = validate_ops([{"op": "set_transform", "clip_id": "c1", "rotation": "180"}], set())
        self.assertEqual(turned, [{"op": "set_transform", "clip_id": "c1", "rotation": 180.0}])

    async def test_pure_edits_do_not_search_and_failures_keep_the_error(self):
        commands = (
            "trim this clip to 2 seconds",
            "split this clip",
            "cut this clip in half",
            "move this clip to 1 second",
            "remove this clip",
            "set volume to 0",
            "add title Hello",
            "update the title",
            "crossfade these clips",
            "rotate this clip 180",
        )

        async def search_only(contents, messages):
            return [Call("search_vault", {"query": "beach"})], contents, messages

        async def forbid_search(*_args, **_kwargs):
            raise AssertionError("a pure edit must not search the vault")

        for command in commands:
            with self.subTest(command=command):
                with (
                    patch("sense.planner._choose_planner", _planner(search_only)),
                    patch("sense.planner._search", forbid_search),
                ):
                    result = await run_command(beach_catalog(), {"command": command, "timeline": timeline(), "library": []})
                self.assertEqual(result["ops"], [])
                self.assertEqual(result["hits"], {"video": [], "audio": [], "image": []})
                self.assertNotIn("beach", result["note"].lower())

        async def fail_then_trim(contents, messages):
            if not fail_then_trim.retried:
                fail_then_trim.retried = True
                return [Call("apply_ops", {"ops": [{"op": "trim", "clip_id": "c1", "duration_s": "nope"}]})], contents, messages
            return [Call("apply_ops", {"ops": [{"op": "trim", "clip_id": "c1", "duration_s": "2"}]})], contents, messages

        fail_then_trim.retried = False
        with (
            patch("sense.planner._choose_planner", _planner(fail_then_trim)),
            patch("sense.planner._search", forbid_search),
        ):
            retried = await run_command(beach_catalog(), {"command": "trim this clip to 2 seconds", "timeline": timeline(), "library": []})
        self.assertEqual(retried["ops"], [{"op": "trim", "clip_id": "c1", "duration_s": 2.0}])
        self.assertNotIn("must be a number", retried["note"])
        self.assertEqual(retried["hits"]["video"], [])

    async def test_failed_place_returns_the_error_without_hits(self):
        async def place(contents, messages):
            if not place.once:
                place.once = True
                return [
                    Call("search_vault", {"query": "beach"}),
                    Call("apply_ops", {"ops": [{"op": "add_clip", "vault_id": "missing", "track": "V1", "start_s": 0}]}),
                ], contents, messages
            return [], contents, messages

        place.once = False
        with patch("sense.planner._choose_planner", _planner(place)):
            result = await run_command(beach_catalog(), {"command": "place the beach clip", "timeline": timeline(), "library": []})
        self.assertEqual(result["ops"], [])
        self.assertEqual(result["hits"], {"video": [], "audio": [], "image": []})
        self.assertIn("vault_id missing is not in the library results.", result["note"])

    async def test_place_can_search_and_then_add(self):
        async def place(contents, messages):
            return [
                Call("search_vault", {"query": "beach"}),
                Call("apply_ops", {"label": "Place beach", "ops": [{"op": "add_clip", "vault_id": "video/beach.mp4", "track": "V1", "start_s": 0}]}),
            ], contents, messages

        with patch("sense.planner._choose_planner", _planner(place)):
            result = await run_command(beach_catalog(), {"command": "place the beach clip on the timeline", "timeline": timeline(), "library": []})
        self.assertEqual(result["ops"], [{"op": "add_clip", "vault_id": "video/beach.mp4", "track": "V1", "start_s": 0.0}])
        self.assertEqual([hit["vault_id"] for hit in result["hits"]["video"]], ["video/beach.mp4"])

    async def test_selection_replaces_other_clip_ids_for_edit_ops(self):
        seen = {}

        async def planner(contents, messages):
            seen["prompt"] = messages[1]["content"]
            return [Call("apply_ops", {"ops": [
                {"op": "trim", "clip_id": "other", "duration_s": 2},
                {"op": "move", "clip_id": "other", "start_s": 1},
                {"op": "set_transform", "clip_id": "other", "rotation": 180},
                {"op": "remove", "clip_id": "other"},
                {"op": "split", "clip_id": "other", "at_s": 1},
            ]})], contents, messages

        body = {
            "command": "trim and rotate this clip",
            "timeline": timeline(),
            "library": [],
            "selected_clip_ids": ["c1"],
        }
        with patch("sense.planner._choose_planner", _planner(planner)):
            result = await run_command(beach_catalog(), body)
        self.assertIn("Selected clip_ids: c1", seen["prompt"])
        by_op = {op["op"]: op for op in result["ops"]}
        self.assertEqual(by_op["trim"]["clip_id"], "c1")
        self.assertEqual(by_op["set_transform"]["clip_id"], "c1")
        self.assertEqual(by_op["set_transform"]["rotation"], 180.0)
        self.assertEqual(by_op["remove"]["clip_id"], "c1")
        self.assertEqual(by_op["split"]["clip_id"], "c1")
        self.assertEqual(by_op["move"]["clip_id"], "other")
        self.assertEqual(result["hits"]["video"], [])

    async def test_several_selected_clips_fan_out_when_the_model_misses_them(self):
        async def planner(contents, messages):
            return [Call("apply_ops", {"ops": [{"op": "remove", "clip_id": "other"}]})], contents, messages

        body = {
            "command": "remove the selected clips",
            "timeline": timeline(),
            "library": [],
            "selected_clip_ids": ["c1", "c2"],
        }
        with patch("sense.planner._choose_planner", _planner(planner)):
            result = await run_command(catalog(), body)
        self.assertEqual(result["ops"], [
            {"op": "remove", "clip_id": "c1"},
            {"op": "remove", "clip_id": "c2"},
        ])

    async def test_find_a_movie_still_searches(self):
        async def empty(contents, messages):
            return [], contents, messages

        with patch("sense.planner._choose_planner", _planner(empty)):
            result = await run_command(beach_catalog(), {"command": "find a movie of the beach", "timeline": timeline(), "library": []})
        self.assertEqual(result["ops"], [])
        self.assertEqual([hit["vault_id"] for hit in result["hits"]["video"]], ["video/beach.mp4"])

    async def test_offline_edit_does_not_invent_hits(self):
        async def offline():
            return None

        with patch("sense.planner._choose_planner", offline):
            result = await run_command(beach_catalog(), {"command": "rotate this clip 180", "timeline": timeline(), "library": []})
        self.assertEqual(result["planner"], "offline")
        self.assertEqual(result["ops"], [])
        self.assertEqual(result["hits"], {"video": [], "audio": [], "image": []})
        self.assertIn("Planner not loaded. No edits were applied.", result["note"])


def _planner(planner):
    async def choose():
        return planner

    return choose


if __name__ == "__main__":
    unittest.main()
