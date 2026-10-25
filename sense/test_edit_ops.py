"""Planner boundary regression tests; no model services or credentials needed."""
import unittest
from unittest.mock import patch

from sense.planner import (
    INSTRUCTIONS,
    TOOLS,
    Call,
    OpError,
    fan_selected_ops,
    ordinal_clip_id,
    run_command,
    steer_extend_animation,
    stitch_created_aliases,
    validate_ops,
)
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
        for word in ("trim", "split", "move", "remove", "set_volume", "add_text", "update_text", "crossfade", "set_transform", "set_motion", "add_clip"):
            self.assertIn(word, apply_ops["description"])
        self.assertIn('{"op":"set_motion","clip_id":"...","property":"rotation","from":30,"to":60,"duration_s":3}', INSTRUCTIONS)
        self.assertIn("extend the rotation to 8 seconds", INSTRUCTIONS)
        self.assertIn("Selected clip_ids in order: 1=<id>, 2=<id>", INSTRUCTIONS)
        self.assertIn("the first one rotate for 3 seconds", INSTRUCTIONS)
        self.assertIn("the second one extend", INSTRUCTIONS)
        self.assertIn("the third trim to 2 seconds", INSTRUCTIONS)
        for phrase in ("first", "second", "third", "1st", "2nd", "3rd", "#1", "#2", "the first selected", "clip 1"):
            self.assertIn(phrase, INSTRUCTIONS)
        self.assertIn("Do not trim it to lengthen the animation.", INSTRUCTIONS)
        self.assertIn("Do not trim a still to lengthen an animation.", apply_ops["description"])
        spun = validate_ops([{"op": "set_motion", "clip_id": "c1", "property": "zoom", "from": "1", "to": 2, "duration_s": "3"}], set())
        self.assertEqual(spun, [{"op": "set_motion", "clip_id": "c1", "property": "scale", "keys": [{"t_s": 0.0, "value": 1.0}, {"t_s": 3.0, "value": 2.0}]}])
        keyed = validate_ops([{"op": "set_motion", "clip_id": "c1", "property": "opacity", "keys": [{"t_s": 1, "value": 0}, {"t_s": 0, "value": "1"}]}], set())
        self.assertEqual(keyed[0]["keys"], [{"t_s": 0.0, "value": 1.0}, {"t_s": 1.0, "value": 0.0}])
        for bad in (
            {"op": "set_motion", "clip_id": "c1", "property": "rotation", "from": 0, "to": 10},
            {"op": "set_motion", "clip_id": "c1", "property": "scale", "from": 1, "to": 0, "duration_s": 1},
            {"op": "set_motion", "clip_id": "c1", "property": "x", "from": 0, "to": 2, "duration_s": 1},
            {"op": "set_motion", "clip_id": "c1", "property": "volume", "from": 0, "to": 1, "duration_s": 1},
        ):
            with self.assertRaises(OpError):
                validate_ops([bad], set())
        self.assertIn("Do not use this to trim", search["description"])
        turned = validate_ops([{"op": "set_transform", "clip_id": "c1", "rotation": "180"}], set())
        self.assertEqual(turned, [{"op": "set_transform", "clip_id": "c1", "rotation": 180.0}])
        self.assertIn("scale replaces the clip scale", INSTRUCTIONS)
        self.assertIn("make it larger and put it in the center", INSTRUCTIONS)
        self.assertIn('{"op":"split","clip_id":"...","at_s":1.5,"right_id":"right-half"}', INSTRUCTIONS)
        self.assertIn('{"op":"remove","clip_id":"right-half"}', INSTRUCTIONS)
        self.assertIn("deletes both halves", INSTRUCTIONS)
        scaled = validate_ops([{"op": "set_transform", "clip_id": "c1", "scale": "2"}], set())
        self.assertEqual(scaled, [{"op": "set_transform", "clip_id": "c1", "scale": 2.0}])
        placed = validate_ops([{"op": "set_transform", "clip_id": "c1", "x": 0.2, "y": "0.8", "scale": 1.5}], set())
        self.assertEqual(placed, [{"op": "set_transform", "clip_id": "c1", "scale": 1.5, "x": 0.2, "y": 0.8}])
        for bad in (
            {"op": "set_transform", "clip_id": "c1"},
            {"op": "set_transform", "clip_id": "c1", "scale": 0},
            {"op": "set_transform", "clip_id": "c1", "scale": -1},
            {"op": "set_transform", "clip_id": "c1", "x": 2},
            {"op": "set_transform", "clip_id": "c1", "y": -0.1},
        ):
            with self.subTest(bad=bad), self.assertRaises(OpError):
                validate_ops([bad], set())

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
            "zoom in on this clip",
            "scale this clip",
            "rotate from 30 to 60 over 3 seconds",
            "zoom from 1 to 2 over 3s",
            "pan left while zooming",
            "fade opacity from 1 to 0",
            "extend the rotation to 8 seconds",
            "make it larger and put it in the center",
            "put it top-left",
            "move it left a bit",
            "split the video here and delete the right part",
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
                {"op": "set_motion", "clip_id": "other", "property": "rotation", "from": 30, "to": 60, "duration_s": 3},
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
        self.assertIn("Selected clip_ids in order: 1=c1", seen["prompt"])
        by_op = {op["op"]: op for op in result["ops"]}
        self.assertEqual(by_op["trim"]["clip_id"], "c1")
        self.assertEqual(by_op["set_transform"]["clip_id"], "c1")
        self.assertEqual(by_op["set_transform"]["rotation"], 180.0)
        self.assertEqual(by_op["set_motion"]["clip_id"], "c1")
        self.assertEqual(by_op["set_motion"]["keys"][1]["value"], 60.0)
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

    async def test_selected_clip_receives_scale(self):
        async def planner(contents, messages):
            return [Call("apply_ops", {"ops": [{"op": "set_transform", "clip_id": "other", "scale": 2}]})], contents, messages

        body = {
            "command": "zoom in on this clip",
            "timeline": timeline(),
            "library": [],
            "selected_clip_ids": ["c1"],
        }
        with patch("sense.planner._choose_planner", _planner(planner)):
            result = await run_command(beach_catalog(), body)
        self.assertEqual(result["ops"], [{"op": "set_transform", "clip_id": "c1", "scale": 2.0}])
        self.assertEqual(result["hits"]["video"], [])

    async def test_several_selected_clips_fan_out_when_the_model_names_one(self):
        async def planner(contents, messages):
            return [Call("apply_ops", {"ops": [
                {"op": "set_transform", "clip_id": "c1", "rotation": 30},
                {"op": "set_transform", "clip_id": "c1", "scale": 2},
                {"op": "set_motion", "clip_id": "c1", "property": "rotation", "from": 30, "to": 60, "duration_s": 1},
                {"op": "move", "clip_id": "other", "start_s": 1},
            ]})], contents, messages

        body = {
            "command": "rotate and zoom the selected clips",
            "timeline": timeline(),
            "library": [],
            "selected_clip_ids": ["c1", "c2"],
        }
        with patch("sense.planner._choose_planner", _planner(planner)):
            result = await run_command(catalog(), body)
        self.assertEqual(
            [op["clip_id"] for op in result["ops"] if op["op"] == "set_transform" and op.get("rotation") == 30.0],
            ["c1", "c2"],
        )
        self.assertEqual(
            [op["clip_id"] for op in result["ops"] if op["op"] == "set_transform" and op.get("scale") == 2.0],
            ["c1", "c2"],
        )
        motions = [op for op in result["ops"] if op["op"] == "set_motion"]
        self.assertEqual([op["clip_id"] for op in motions], ["c1", "c2"])
        self.assertEqual(motions[0]["keys"], [{"t_s": 0.0, "value": 30.0}, {"t_s": 1.0, "value": 60.0}])
        self.assertEqual(result["ops"][-1], {"op": "move", "clip_id": "other", "start_s": 1.0})
        self.assertEqual(len(result["ops"]), 7)

    async def test_named_selected_clip_stays_a_single_op(self):
        async def planner(contents, messages):
            return [Call("apply_ops", {"ops": [
                {"op": "set_transform", "clip_id": "c1", "rotation": 30},
            ]})], contents, messages

        body = {
            "command": "rotate this clip 30",
            "timeline": timeline(),
            "library": [],
            "selected_clip_ids": ["c1"],
        }
        with patch("sense.planner._choose_planner", _planner(planner)):
            result = await run_command(catalog(), body)
        self.assertEqual(result["ops"], [{"op": "set_transform", "clip_id": "c1", "rotation": 30.0}])

    async def test_extend_rotation_rewrites_a_source_trim(self):
        async def planner(contents, messages):
            return [Call("apply_ops", {"ops": [{"op": "trim", "clip_id": "c1", "duration_s": 8}]})], contents, messages

        body = {"command": "extend the rotation to 8 seconds", "timeline": _spinning_timeline(), "library": []}
        with patch("sense.planner._choose_planner", _planner(planner)):
            result = await run_command(catalog(), body)
        self.assertEqual(result["ops"], [{
            "op": "set_motion",
            "clip_id": "c1",
            "property": "rotation",
            "keys": [{"t_s": 0.0, "value": 30.0}, {"t_s": 8.0, "value": 90.0}],
        }])

    async def test_plain_trim_stays_a_trim(self):
        async def planner(contents, messages):
            return [Call("apply_ops", {"ops": [{"op": "trim", "clip_id": "c1", "duration_s": 8}]})], contents, messages

        body = {"command": "trim this clip to 8 seconds", "timeline": _spinning_timeline(), "library": []}
        with patch("sense.planner._choose_planner", _planner(planner)):
            result = await run_command(catalog(), body)
        self.assertEqual(result["ops"], [{"op": "trim", "clip_id": "c1", "duration_s": 8.0}])

    async def test_extend_rotation_fans_out_across_selected_stills(self):
        async def planner(contents, messages):
            return [Call("apply_ops", {"ops": [{"op": "trim", "clip_id": "other", "duration_s": 8}]})], contents, messages

        timeline = _spinning_timeline()
        timeline["tracks"][0]["clips"].append({
            "id": "c2-engine",
            "alias": "c2",
            "type": "image",
            "duration_s": 2.4,
            "motion": {"rotation": [{"t_s": 0, "value": 0}, {"t_s": 2, "value": 45}]},
        })
        body = {
            "command": "extend the rotation to 8 seconds",
            "timeline": timeline,
            "library": [],
            "selected_clip_ids": ["c1", "c2"],
        }
        with patch("sense.planner._choose_planner", _planner(planner)):
            result = await run_command(catalog(), body)
        self.assertEqual(result["ops"], [
            {"op": "set_motion", "clip_id": "c1", "property": "rotation", "keys": [{"t_s": 0.0, "value": 30.0}, {"t_s": 8.0, "value": 90.0}]},
            {"op": "set_motion", "clip_id": "c2", "property": "rotation", "keys": [{"t_s": 0.0, "value": 0.0}, {"t_s": 8.0, "value": 45.0}]},
        ])

    def test_extend_animation_stretches_existing_keys(self):
        timeline = _spinning_timeline()
        timeline["tracks"][0]["clips"][0]["motion"]["scale"] = [{"t_s": 0, "value": 1}, {"t_s": 1, "value": 2}, {"t_s": 2, "value": 3}]
        timeline["tracks"][0]["clips"][0]["motion"]["x"] = [{"t_s": 0, "value": 0.2}, {"t_s": 2, "value": 0.8}]
        timeline["tracks"][0]["clips"][0]["motion"]["y"] = [{"t_s": 0, "value": 0.4}, {"t_s": 2, "value": 0.6}]
        spun = steer_extend_animation("lengthen the spin to 8s", timeline, [{"op": "trim", "clip_id": "c1", "duration_s": 8}], [])
        self.assertEqual(spun, [{
            "op": "set_motion",
            "clip_id": "c1",
            "property": "rotation",
            "keys": [{"t_s": 0.0, "value": 30.0}, {"t_s": 8.0, "value": 90.0}],
        }])
        short = steer_extend_animation(
            "make the rotation last 8 seconds",
            timeline,
            [
                {"op": "trim", "clip_id": "c1", "duration_s": 8, "in_s": 1},
                {"op": "set_motion", "clip_id": "c1", "property": "rotation", "keys": [{"t_s": 0.0, "value": 15.0}, {"t_s": 2.0, "value": 75.0}]},
            ],
            [],
        )
        self.assertEqual(short[0], {"op": "trim", "clip_id": "c1", "duration_s": 8, "in_s": 1})
        self.assertEqual(short[1]["keys"], [{"t_s": 0.0, "value": 15.0}, {"t_s": 8.0, "value": 75.0}])
        animated = steer_extend_animation("extend the animation to 4 seconds", timeline, [{"op": "trim", "clip_id": "c1", "duration_s": 4}], [])
        by_prop = {op["property"]: op["keys"] for op in animated}
        self.assertEqual(by_prop["rotation"], [{"t_s": 0.0, "value": 30.0}, {"t_s": 4.0, "value": 90.0}])
        self.assertEqual(by_prop["scale"], [{"t_s": 0.0, "value": 1.0}, {"t_s": 2.0, "value": 2.0}, {"t_s": 4.0, "value": 3.0}])
        self.assertEqual(by_prop["x"], [{"t_s": 0.0, "value": 0.2}, {"t_s": 4.0, "value": 0.8}])
        self.assertEqual(by_prop["y"][1], {"t_s": 4.0, "value": 0.6})
        panned = steer_extend_animation("extend the pan to 3 seconds", timeline, [], ["c1"])
        self.assertEqual([op["property"] for op in panned], ["x", "y"])
        self.assertEqual(panned[0]["keys"][1], {"t_s": 3.0, "value": 0.8})
        self.assertEqual(panned[1]["keys"][1], {"t_s": 3.0, "value": 0.6})


    def test_prompt_shows_hello_world_rotation_on_one_clip_id(self):
        self.assertIn(
            '{"op":"add_text","clip_id":"text_hello_world","content":"Hello World","track":"T1","start_s":0,"duration_s":10}',
            INSTRUCTIONS,
        )
        self.assertIn(
            '{"op":"set_motion","clip_id":"text_hello_world","property":"rotation","from":0,"to":360,"duration_s":10}',
            INSTRUCTIONS,
        )
        self.assertIn("duration_s at least N", INSTRUCTIONS)

    def test_new_text_without_clip_id_takes_the_invented_motion_id(self):
        ops = stitch_created_aliases([
            {"op": "add_text", "content": "Hello World", "track": "T1", "start_s": 0, "duration_s": 2},
            _rotation("text_hello_world"),
        ], timeline())
        self.assertEqual(len(ops), 2)
        self.assertEqual(ops[0]["op"], "add_text")
        self.assertEqual(ops[0]["clip_id"], "text_hello_world")
        self.assertEqual(ops[0]["content"], "Hello World")
        self.assertEqual(ops[0]["start_s"], 0)
        self.assertEqual(ops[1]["clip_id"], "text_hello_world")
        self.assertEqual(ops[1]["op"], "set_motion")

    def test_text_create_with_the_same_clip_id_stays_unchanged(self):
        ops = [
            {"op": "add_text", "clip_id": "title1", "content": "Hello World", "start_s": 0, "duration_s": 10},
            _rotation("title1"),
        ]
        self.assertEqual(stitch_created_aliases(ops, timeline()), ops)

    def test_motion_before_the_text_create_runs_after_the_alias_is_stamped(self):
        ops = stitch_created_aliases([
            _rotation("text_hello_world"),
            {"op": "add_text", "content": "Hello World", "start_s": 0, "duration_s": 10},
        ], {"tracks": []})
        self.assertEqual([op["op"] for op in ops], ["add_text", "set_motion"])
        self.assertEqual(ops[0]["clip_id"], "text_hello_world")
        self.assertEqual(ops[1]["clip_id"], "text_hello_world")

    def test_invented_follow_up_uses_the_create_clip_id(self):
        ops = stitch_created_aliases([
            {"op": "add_text", "clip_id": "title1", "content": "Hello World", "start_s": 0, "duration_s": 10},
            _rotation("text_hello_world"),
        ], timeline())
        self.assertEqual(ops[0]["clip_id"], "title1")
        self.assertEqual(ops[1]["clip_id"], "title1")

    def test_one_new_text_keeps_one_alias(self):
        ops = stitch_created_aliases([
            {"op": "add_text", "content": "Hello World", "start_s": 0, "duration_s": 10},
            _rotation("text_hello_world"),
            {"op": "set_motion", "clip_id": "text_hello_zoom", "property": "scale", "keys": [{"t_s": 0.0, "value": 1.0}, {"t_s": 10.0, "value": 2.0}]},
        ], {"tracks": []})
        self.assertEqual([op["op"] for op in ops], ["add_text", "set_motion", "set_motion"])
        self.assertEqual([op["clip_id"] for op in ops], ["text_hello_world", "text_hello_world", "text_hello_world"])

    def test_two_new_texts_keep_separate_aliases(self):
        ops = stitch_created_aliases([
            {"op": "add_text", "content": "Hello", "start_s": 0, "duration_s": 2},
            {"op": "add_text", "content": "World", "start_s": 2, "duration_s": 2},
            _rotation("text_hello"),
            _rotation("text_world"),
        ], {"tracks": []})
        self.assertEqual([op.get("clip_id") for op in ops], ["text_hello", "text_world", "text_hello", "text_world"])

    def test_timeline_clip_is_not_retargeted_onto_new_text(self):
        ops = [
            {"op": "add_text", "content": "Hello", "start_s": 0, "duration_s": 2},
            _rotation("c1"),
        ]
        self.assertEqual(stitch_created_aliases(ops, timeline()), ops)

    def test_split_alias_is_not_stolen_by_a_new_text(self):
        ops = [
            {"op": "split", "clip_id": "c1", "at_s": 1, "right_id": "right-half"},
            {"op": "set_transform", "clip_id": "right-half", "rotation": 10},
            {"op": "add_text", "content": "Hello", "start_s": 0, "duration_s": 2},
        ]
        self.assertEqual(stitch_created_aliases(ops, timeline()), ops)

    def test_earlier_text_alias_is_not_copied_onto_a_second_text(self):
        ops = [
            {"op": "add_text", "clip_id": "title1", "content": "Hello", "start_s": 0, "duration_s": 2},
            {"op": "add_text", "content": "World", "start_s": 2, "duration_s": 2},
            _rotation("title1"),
        ]
        stitched = stitch_created_aliases(ops, timeline())
        self.assertEqual(stitched[0]["clip_id"], "title1")
        self.assertNotIn("clip_id", stitched[1])
        self.assertEqual(stitched[2]["clip_id"], "title1")

    def test_new_clip_without_clip_id_takes_the_invented_edit_id(self):
        ops = stitch_created_aliases([
            {"op": "add_clip", "vault_id": "video/flower.mp4", "track": "V1", "start_s": 0},
            {"op": "set_transform", "clip_id": "flower", "rotation": 90},
        ], {"tracks": []})
        self.assertEqual(ops[0]["clip_id"], "flower")
        self.assertEqual(ops[1]["clip_id"], "flower")

    def test_text_and_clip_creates_keep_their_own_aliases(self):
        ops = stitch_created_aliases([
            {"op": "add_clip", "vault_id": "video/flower.mp4", "track": "V1", "start_s": 0},
            {"op": "add_text", "content": "Hello World", "start_s": 0, "duration_s": 10},
            _rotation("text_hello_world"),
            {"op": "set_transform", "clip_id": "flower", "rotation": 90},
        ], {"tracks": []})
        by_op = {}
        for op in ops:
            by_op.setdefault(op["op"], []).append(op.get("clip_id"))
        self.assertEqual(by_op["add_text"], ["text_hello_world"])
        self.assertEqual(by_op["add_clip"], ["flower"])
        self.assertEqual(by_op["set_motion"], ["text_hello_world"])
        self.assertEqual(by_op["set_transform"], ["flower"])

    async def test_hello_world_rotation_binds_before_the_host_sees_ops(self):
        async def planner(contents, messages):
            return [Call("apply_ops", {"ops": [
                {"op": "add_text", "content": "Hello World", "track": "T1", "start_s": 0, "duration_s": 2},
                {"op": "set_motion", "clip_id": "text_hello_world", "property": "rotation", "from": 0, "to": 360, "duration_s": 10},
            ]})], contents, messages

        body = {
            "command": "Create a text called Hello World and put in the start and rotate it for ten seconds",
            "timeline": timeline(),
            "library": [],
        }
        with patch("sense.planner._choose_planner", _planner(planner)):
            result = await run_command(catalog(), body)
        self.assertEqual(result["ops"], [
            {
                "op": "add_text",
                "content": "Hello World",
                "start_s": 0.0,
                "duration_s": 2.0,
                "track": "T1",
                "clip_id": "text_hello_world",
            },
            {
                "op": "set_motion",
                "clip_id": "text_hello_world",
                "property": "rotation",
                "keys": [{"t_s": 0.0, "value": 0.0}, {"t_s": 10.0, "value": 360.0}],
            },
        ])
        self.assertEqual(result["hits"], {"video": [], "audio": [], "image": []})

    async def test_selected_clip_is_not_stamped_onto_a_new_text(self):
        async def planner(contents, messages):
            return [Call("apply_ops", {"ops": [
                {"op": "add_text", "content": "Hello", "start_s": 0, "duration_s": 2},
                {"op": "set_motion", "clip_id": "text_hello_world", "property": "rotation", "from": 0, "to": 90, "duration_s": 1},
            ]})], contents, messages

        body = {
            "command": "add a title and rotate the selection",
            "timeline": timeline(),
            "library": [],
            "selected_clip_ids": ["c1"],
        }
        with patch("sense.planner._choose_planner", _planner(planner)):
            result = await run_command(catalog(), body)
        self.assertNotIn("clip_id", result["ops"][0])
        self.assertEqual(result["ops"][1]["clip_id"], "c1")

    def test_ordinal_phrases_map_onto_selection_order(self):
        selected = ["alpha", "beta", "gamma"]
        expected = {
            "first": "alpha",
            "the first one": "alpha",
            "the first selected": "alpha",
            "1st": "alpha",
            "#1": "alpha",
            "clip 1": "alpha",
            "second": "beta",
            "2nd": "beta",
            "#2": "beta",
            "clip 2": "beta",
            "third": "gamma",
            "3rd": "gamma",
            "#3": "gamma",
            "clip 3": "gamma",
        }
        for phrase, clip_id in expected.items():
            with self.subTest(phrase=phrase):
                self.assertEqual(ordinal_clip_id(selected, phrase), clip_id)
        self.assertIsNone(ordinal_clip_id(selected, "rotate all selected 90"))
        self.assertIsNone(ordinal_clip_id(selected, "first and second"))

    async def test_prompt_lists_selected_clips_in_selection_order(self):
        seen = {}

        async def planner(contents, messages):
            seen["prompt"] = messages[1]["content"]
            return [], contents, messages

        body = {
            "command": "rotate all selected 90",
            "timeline": timeline(),
            "library": [],
            "selected_clip_ids": ["c3", "c1", "c2"],
        }
        with patch("sense.planner._choose_planner", _planner(planner)):
            await run_command(catalog(), body)
        self.assertIn("Selected clip_ids in order: 1=c3, 2=c1, 3=c2", seen["prompt"])

    async def test_mixed_ordinal_command_keeps_distinct_ops(self):
        async def planner(contents, messages):
            return [Call("apply_ops", {"ops": [
                {"op": "set_motion", "clip_id": "c1", "property": "rotation", "from": 0, "to": 90, "duration_s": 3},
                {"op": "set_motion", "clip_id": "c2", "property": "rotation", "from": 10, "to": 40, "duration_s": 8},
                {"op": "trim", "clip_id": "c3", "duration_s": 2},
            ]})], contents, messages

        body = {
            "command": "first rotate for 3 seconds, second extend the rotation to 8 seconds, third trim to 2 seconds",
            "timeline": _three_spinning_clips(),
            "library": [],
            "selected_clip_ids": ["c1", "c2", "c3"],
        }
        with patch("sense.planner._choose_planner", _planner(planner)):
            result = await run_command(catalog(), body)
        self.assertEqual(result["ops"], [
            {"op": "set_motion", "clip_id": "c1", "property": "rotation", "keys": [{"t_s": 0.0, "value": 0.0}, {"t_s": 3.0, "value": 90.0}]},
            {"op": "set_motion", "clip_id": "c2", "property": "rotation", "keys": [{"t_s": 0.0, "value": 10.0}, {"t_s": 8.0, "value": 40.0}]},
            {"op": "trim", "clip_id": "c3", "duration_s": 2.0},
        ])

    async def test_ordinal_tokens_resolve_without_fanning(self):
        async def planner(contents, messages):
            return [Call("apply_ops", {"ops": [
                {"op": "set_motion", "clip_id": "1st", "property": "rotation", "from": 0, "to": 90, "duration_s": 3},
                {"op": "set_motion", "clip_id": "the second one", "property": "rotation", "from": 10, "to": 40, "duration_s": 8},
                {"op": "trim", "clip_id": "clip 3", "duration_s": 2},
            ]})], contents, messages

        body = {
            "command": "the first one rotate for 3 seconds, the second one extend the rotation to 8 seconds, the third trim to 2 seconds",
            "timeline": _three_spinning_clips(),
            "library": [],
            "selected_clip_ids": ["c1", "c2", "c3"],
        }
        with patch("sense.planner._choose_planner", _planner(planner)):
            result = await run_command(catalog(), body)
        self.assertEqual([op["clip_id"] for op in result["ops"]], ["c1", "c2", "c3"])
        self.assertEqual(result["ops"][0]["keys"][1], {"t_s": 3.0, "value": 90.0})
        self.assertEqual(result["ops"][1]["keys"][1], {"t_s": 8.0, "value": 40.0})
        self.assertEqual(result["ops"][2], {"op": "trim", "clip_id": "c3", "duration_s": 2.0})

    def test_ordinal_batch_does_not_fan_and_uniform_batch_does(self):
        selected = ["c1", "c2", "c3"]
        mixed = fan_selected_ops(
            [
                {"op": "set_transform", "clip_id": "c1", "rotation": 15},
                {"op": "trim", "clip_id": "c2", "duration_s": 2},
            ],
            selected,
            "edit the selected clips",
        )
        self.assertEqual(mixed, [
            {"op": "set_transform", "clip_id": "c1", "rotation": 15},
            {"op": "trim", "clip_id": "c2", "duration_s": 2},
        ])
        uniform = fan_selected_ops(
            [{"op": "set_transform", "clip_id": "c1", "rotation": 90}],
            selected,
            "rotate all selected 90",
        )
        self.assertEqual(uniform, [
            {"op": "set_transform", "clip_id": "c1", "rotation": 90},
            {"op": "set_transform", "clip_id": "c2", "rotation": 90},
            {"op": "set_transform", "clip_id": "c3", "rotation": 90},
        ])
        partial = fan_selected_ops(
            [
                {"op": "set_transform", "clip_id": "c1", "rotation": 90},
                {"op": "set_transform", "clip_id": "c2", "rotation": 90},
            ],
            selected,
            "rotate all selected 90",
        )
        self.assertEqual(partial, uniform)
        named = fan_selected_ops(
            [
                {"op": "set_motion", "clip_id": "#1", "property": "rotation", "duration_s": 3},
                {"op": "trim", "clip_id": "2nd", "duration_s": 2},
            ],
            selected,
            "first rotate for 3 seconds, second trim to 2 seconds",
        )
        self.assertEqual([op["clip_id"] for op in named], ["c1", "c2"])
        held = fan_selected_ops(
            [{"op": "set_transform", "clip_id": "c1", "rotation": 90}],
            selected,
            "the first one rotate 90",
        )
        self.assertEqual(held, [{"op": "set_transform", "clip_id": "c1", "rotation": 90}])

    async def test_rotate_all_selected_still_fans(self):
        async def planner(contents, messages):
            return [Call("apply_ops", {"ops": [{"op": "set_transform", "clip_id": "c1", "rotation": 90}]})], contents, messages

        body = {
            "command": "rotate all selected 90",
            "timeline": timeline(),
            "library": [],
            "selected_clip_ids": ["c1", "c2", "c3"],
        }
        with patch("sense.planner._choose_planner", _planner(planner)):
            result = await run_command(catalog(), body)
        self.assertEqual(result["ops"], [
            {"op": "set_transform", "clip_id": "c1", "rotation": 90.0},
            {"op": "set_transform", "clip_id": "c2", "rotation": 90.0},
            {"op": "set_transform", "clip_id": "c3", "rotation": 90.0},
        ])

    async def test_ordinal_extend_does_not_rewrite_the_other_clips(self):
        async def planner(contents, messages):
            return [Call("apply_ops", {"ops": [
                {"op": "set_motion", "clip_id": "c1", "property": "rotation", "from": 0, "to": 90, "duration_s": 3},
                {"op": "trim", "clip_id": "c2", "duration_s": 8},
                {"op": "trim", "clip_id": "c3", "duration_s": 2},
            ]})], contents, messages

        body = {
            "command": "first rotate for 3 seconds, second extend the rotation to 8 seconds, third trim to 2 seconds",
            "timeline": _three_spinning_clips(),
            "library": [],
            "selected_clip_ids": ["c1", "c2", "c3"],
        }
        with patch("sense.planner._choose_planner", _planner(planner)):
            result = await run_command(catalog(), body)
        by_id = {op["clip_id"]: op for op in result["ops"]}
        self.assertEqual(set(by_id), {"c1", "c2", "c3"})
        self.assertEqual(by_id["c1"]["keys"][1]["t_s"], 3.0)
        self.assertEqual(by_id["c2"]["op"], "set_motion")
        self.assertEqual(by_id["c2"]["keys"], [{"t_s": 0.0, "value": 30.0}, {"t_s": 8.0, "value": 90.0}])
        self.assertEqual(by_id["c3"], {"op": "trim", "clip_id": "c3", "duration_s": 2.0})


    def test_invented_layout_names_become_set_transform(self):
        timeline = _clip_timeline(scale=2, x=0.4, y=0.7)
        larger = validate_ops([{"op": "scale", "clip_id": "c1", "scale": "larger"}], set(), timeline)
        self.assertEqual(larger[0]["op"], "set_transform")
        self.assertAlmostEqual(larger[0]["scale"], 3.0)
        zoom_in = validate_ops([{"op": "zoom_in", "clip_id": "c1"}], set(), timeline)
        self.assertAlmostEqual(zoom_in[0]["scale"], 3.0)
        zoom_out = validate_ops([{"op": "zoom_out", "clip_id": "c1"}], set(), timeline)
        self.assertAlmostEqual(zoom_out[0]["scale"], 2 / 1.5)
        center = validate_ops([{"op": "center", "clip_id": "c1"}], set(), timeline)
        self.assertEqual(center, [{"op": "set_transform", "clip_id": "c1", "x": 0.5, "y": 0.5}])
        corner = validate_ops([{"op": "position", "clip_id": "c1", "position": "top-left"}], set(), timeline)
        self.assertEqual(corner[0]["x"], 0.0)
        self.assertEqual(corner[0]["y"], 0.0)
        turned = validate_ops([{"op": "rotate", "clip_id": "c1", "degrees": 90}], set(), timeline)
        self.assertEqual(turned, [{"op": "set_transform", "clip_id": "c1", "rotation": 90.0}])
        flipped = validate_ops([{"op": "flip", "clip_id": "c1"}], set(), timeline)
        self.assertEqual(flipped[0]["rotation"], 180.0)
        nudged = validate_ops([{"op": "nudge", "clip_id": "c1", "direction": "left"}], set(), timeline)
        self.assertAlmostEqual(nudged[0]["x"], 0.3)
        raised = validate_ops([{"op": "nudge", "clip_id": "c1", "direction": "up"}], set(), timeline)
        self.assertAlmostEqual(raised[0]["y"], 0.6)
        shrunk = validate_ops([{"op": "resize", "clip_id": "c1", "scale": "smaller"}], set(), timeline)
        self.assertAlmostEqual(shrunk[0]["scale"], 2 / 1.5)
        parked = validate_ops(
            [{"op": "set_transform", "clip_id": "c1", "scale": 1}],
            set(),
            timeline,
            "put it top-left",
        )
        self.assertEqual(parked[0]["x"], 0.0)
        self.assertEqual(parked[0]["y"], 0.0)
        moved = validate_ops([{"op": "move_to", "clip_id": "c1", "x": 0.2, "y": 0.3}], set(), timeline)
        self.assertEqual(moved, [{"op": "set_transform", "clip_id": "c1", "x": 0.2, "y": 0.3}])
        zoomed = validate_ops([{"op": "set_transform", "clip_id": "c1", "zoom": 4}], set(), timeline)
        self.assertEqual(zoomed, [{"op": "set_transform", "clip_id": "c1", "scale": 4.0}])
        motion = validate_ops(
            [{"op": "zoom", "clip_id": "c1", "from": 1, "to": 2, "duration_s": 3}],
            set(),
            timeline,
        )
        self.assertEqual(motion[0]["op"], "set_motion")
        self.assertEqual(motion[0]["property"], "scale")
        filled = validate_ops(
            [{"op": "set_transform", "clip_id": "c1", "scale": 2}],
            set(),
            _clip_timeline(scale=1),
            "make it larger and put it in the center",
        )
        self.assertEqual(filled, [{"op": "set_transform", "clip_id": "c1", "scale": 2.0, "x": 0.5, "y": 0.5}])
        with self.assertRaises(OpError) as caught:
            validate_ops([{"op": "frobnicate", "clip_id": "c1"}], set(), timeline)
        self.assertEqual(str(caught.exception), "Unknown op.")

    async def test_larger_and_center_uses_selected_clip_scale(self):
        async def planner(contents, messages):
            return [Call("apply_ops", {"ops": [
                {"op": "scale", "clip_id": "other", "scale": "larger"},
                {"op": "center", "clip_id": "other"},
            ]})], contents, messages

        body = {
            "command": "make it larger and put it in the center",
            "timeline": _clip_timeline(scale=1.25, x=0.2, y=0.8),
            "library": [],
            "selected_clip_ids": ["c1"],
        }
        with patch("sense.planner._choose_planner", _planner(planner)):
            result = await run_command(beach_catalog(), body)
        transforms = [op for op in result["ops"] if op["op"] == "set_transform"]
        self.assertTrue(transforms)
        self.assertTrue(all(op["clip_id"] == "c1" for op in transforms))
        self.assertGreater(max(op.get("scale", 0) for op in transforms), 1.25)
        self.assertTrue(any(op.get("x") == 0.5 and op.get("y") == 0.5 for op in transforms))
        self.assertNotIn("Unknown op", result["note"])
        self.assertEqual(result["hits"]["video"], [])

    async def test_split_here_also_removes_the_right_half(self):
        phrases = (
            ("split the video here and delete the right part", 3.0),
            ("cut here and delete the right", 3.0),
            ("split and keep the left", 2.0),
            ("remove everything after the cut", 2.0),
        )

        async def planner(contents, messages):
            return [Call("apply_ops", {"ops": [{"op": "split", "clip_id": "other", "at_s": 2}]})], contents, messages

        for command, at_s in phrases:
            with self.subTest(command=command):
                body = {
                    "command": command,
                    "timeline": timeline(),
                    "library": [],
                    "selected_clip_ids": ["c1"],
                    "playhead_s": 3,
                }
                with patch("sense.planner._choose_planner", _planner(planner)):
                    result = await run_command(beach_catalog(), body)
                _assert_right_cut(self, result, at_s)
                self.assertNotIn("Unknown op", result["note"])

    async def test_remove_after_split_targets_the_right_alias_not_the_parent(self):
        async def planner(contents, messages):
            return [Call("apply_ops", {"ops": [
                {"op": "split", "clip_id": "other", "at_s": 2},
                {"op": "remove", "clip_id": "other"},
            ]})], contents, messages

        body = {
            "command": "split the video here and delete the right part",
            "timeline": timeline(),
            "library": [],
            "selected_clip_ids": ["c1"],
            "playhead_s": 3,
        }
        with patch("sense.planner._choose_planner", _planner(planner)):
            result = await run_command(catalog(), body)
        _assert_right_cut(self, result, 3.0)
        self.assertFalse(any(op.get("clip_id") == "c1" and op["op"] == "remove" for op in result["ops"]))

    def test_selected_fanout_keeps_the_right_half_remove(self):
        ops = fan_selected_ops(
            [
                {"op": "split", "clip_id": "c1", "at_s": 3, "right_id": "right-half"},
                {"op": "remove", "clip_id": "right-half"},
            ],
            ["c1"],
        )
        self.assertEqual(ops[1]["clip_id"], "right-half")
        self.assertEqual(ops[0]["right_id"], "right-half")
        fanned = fan_selected_ops(
            [
                {"op": "split", "clip_id": "c1", "at_s": 3, "right_id": "right-half"},
                {"op": "remove", "clip_id": "right-half"},
            ],
            ["c1", "c2"],
        )
        self.assertEqual(
            [(op["clip_id"], op["right_id"]) for op in fanned if op["op"] == "split"],
            [("c1", "c1__right"), ("c2", "c2__right")],
        )
        self.assertEqual(
            [op["clip_id"] for op in fanned if op["op"] == "remove"],
            ["c1__right", "c2__right"],
        )

    def test_keep_the_right_removes_the_left_half(self):
        ops = validate_ops(
            [{"op": "split", "clip_id": "c1", "at_s": 4}],
            set(),
            timeline(),
            "split and keep the right",
        )
        self.assertEqual(ops[0]["op"], "split")
        self.assertEqual(ops[0]["at_s"], 4.0)
        self.assertEqual(ops[1], {"op": "remove", "clip_id": ops[0]["left_id"]})
        self.assertNotIn("right_id", ops[0])

    async def test_split_into_two_and_delete_the_right_part(self):
        command = "split it into two and delete the right part"
        batches = (
            ([{"op": "divide", "clip_id": "c1", "at_s": 2}], 2.0),
            ([{"op": "split", "clip_id": "other", "at_s": 2}], 2.0),
            ([{}], 3.0),
            ([{"op": "frobnicate", "clip_id": "c1"}], 3.0),
        )
        for raw, at_s in batches:
            with self.subTest(raw=raw):
                result = await _run_edit(command, raw, playhead_s=3)
                self.assertNotIn("Unknown op", result["note"])
                self.assertEqual([op["op"] for op in result["ops"]], ["split", "remove"])
                _assert_right_cut(self, result, at_s)

        variants = (
            ("split here and delete the right", [{"op": "divide", "clip_id": "c1", "at_s": 9}], 3.0),
            ("split in half and keep the left", [{"op": "split_in_half", "clip_id": "c1", "at_s": 2}], 2.0),
            ("cut into 2 and remove the right half", [{"op": "bisect", "clip_id": "c1", "at_s": 2}], 2.0),
            ("chop here and trash everything after", [{"op": "chop", "clip_id": "c1"}], 3.0),
            ("chop here and trash everything after", [{}], 3.0),
        )
        for command, raw, at_s in variants:
            with self.subTest(command=command, raw=raw):
                result = await _run_edit(command, raw, playhead_s=3)
                self.assertNotIn("Unknown op", result["note"])
                self.assertEqual([op["op"] for op in result["ops"]], ["split", "remove"])
                _assert_right_cut(self, result, at_s)

        left = validate_ops(
            [{"op": "halve", "clip_id": "other", "at_s": 4}],
            set(),
            timeline(),
            "split and delete the left",
            selected=["c1"],
        )
        self.assertEqual(left[0]["op"], "split")
        self.assertEqual(left[0]["clip_id"], "c1")
        self.assertEqual(left[0]["at_s"], 4.0)
        self.assertEqual(left[1], {"op": "remove", "clip_id": left[0]["left_id"]})
        self.assertNotIn("right_id", left[0])

        for invented in ("divide", "bisect", "split_into_two", "split_in_half", "halve", "chop", "cut_right"):
            with self.subTest(invented=invented):
                aliased = validate_ops(
                    [{"op": invented, "clip_id": "c1", "at_s": 2}],
                    set(),
                    timeline(),
                    "split this clip",
                )
                self.assertEqual(aliased, [{"op": "split", "clip_id": "c1", "at_s": 2.0}])

        kept = validate_ops(
            [{"op": "remove", "clip_id": "c1"}],
            set(),
            timeline(),
            "delete the right part",
            playhead_s=3,
            selected=["c1"],
        )
        self.assertEqual(kept, [{"op": "remove", "clip_id": "c1"}])
        parked = validate_ops(
            [{"op": "set_transform", "clip_id": "c1", "x": 0.8}],
            set(),
            timeline(),
            "drop it on the right",
        )
        self.assertEqual(parked, [{"op": "set_transform", "clip_id": "c1", "x": 0.8}])

        for phrase in (
            "split here and delete the right",
            "split it into two and delete the right part",
            "split in half and keep the left",
            "cut into 2 and remove the right half",
            "chop here and trash everything after",
            "split_into_two",
            "bisect",
            "cut_right",
        ):
            self.assertIn(phrase, INSTRUCTIONS)


def _rotation(clip_id, seconds=10.0):
    return {
        "op": "set_motion",
        "clip_id": clip_id,
        "property": "rotation",
        "keys": [{"t_s": 0.0, "value": 0.0}, {"t_s": float(seconds), "value": 360.0}],
    }


def _three_spinning_clips():
    timeline = _spinning_timeline()
    timeline["tracks"][0]["clips"].extend([
        {
            "id": "c2-engine",
            "alias": "c2",
            "type": "image",
            "duration_s": 2.4,
            "motion": {"rotation": [{"t_s": 0, "value": 30}, {"t_s": 2, "value": 90}]},
        },
        {
            "id": "c3-engine",
            "alias": "c3",
            "type": "image",
            "duration_s": 2.4,
            "motion": {"rotation": [{"t_s": 0, "value": 0}, {"t_s": 2, "value": 45}]},
        },
    ])
    return timeline


def _spinning_timeline():
    return {
        "tracks": [{
            "alias": "V1",
            "kind": "video",
            "clips": [{
                "id": "c1-engine",
                "alias": "c1",
                "type": "image",
                "duration_s": 2.4,
                "motion": {"rotation": [{"t_s": 0, "value": 30}, {"t_s": 2, "value": 90}]},
            }],
        }],
    }


def _clip_timeline(**fields):
    data = timeline()
    data["tracks"][0]["clips"][0].update(fields)
    return data


def _assert_right_cut(test, result, at_s):
    split = next(op for op in result["ops"] if op["op"] == "split")
    remove = next(op for op in result["ops"] if op["op"] == "remove")
    test.assertEqual(split["clip_id"], "c1")
    test.assertAlmostEqual(split["at_s"], at_s)
    test.assertEqual(remove["clip_id"], split["right_id"])
    test.assertNotEqual(remove["clip_id"], split["clip_id"])
    test.assertLess(
        [op["op"] for op in result["ops"]].index("split"),
        [op["op"] for op in result["ops"]].index("remove"),
    )
    test.assertEqual([op["op"] for op in result["ops"]].count("remove"), 1)


def _planner(planner):
    async def choose():
        return planner

    return choose


async def _run_edit(command, raw, playhead_s=None):
    async def planner(contents, messages, ops=raw):
        return [Call("apply_ops", {"ops": ops})], contents, messages

    body = {
        "command": command,
        "timeline": timeline(),
        "library": [],
        "selected_clip_ids": ["c1"],
    }
    if playhead_s is not None:
        body["playhead_s"] = playhead_s
    with patch("sense.planner._choose_planner", _planner(planner)):
        return await run_command(beach_catalog(), body)


if __name__ == "__main__":
    unittest.main()
