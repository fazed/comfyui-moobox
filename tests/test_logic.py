import copy
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from logic import filter_words, format_tags, join_prompt, order_illustrious, read_categories, split_words
from migrate_workflow import convert_workflow


class TriggerTests(unittest.TestCase):
    def test_weighted_commas_and_escaping(self):
        self.assertEqual(split_words(r"alpha, (beta, gamma:0.8), cat \(ears\)"), ["alpha", "(beta, gamma:0.8)", r"cat \(ears\)"])

    def test_group_child_and_strength(self):
        state = {"groups": [{"text": "alpha, beta", "active": True, "strength": 0.8, "items": [{"text": "alpha", "active": True}, {"text": "beta", "active": False}]}]}
        original = copy.deepcopy(state)
        self.assertEqual(filter_words("alpha, beta,, gamma", state, False), "(alpha:0.8)")
        self.assertEqual(state, original)

    def test_all_disabled_is_empty(self):
        self.assertEqual(filter_words("alpha", {"groups": [{"text": "alpha", "active": False}]}, True), "")

    def test_duplicate_groups(self):
        state = {"groups": [{"text": "alpha", "active": False}, {"text": "alpha", "active": True}]}
        self.assertEqual(filter_words("alpha,, alpha", state, True), "alpha")

    def test_new_source_keeps_existing_choices(self):
        state = {"groups": [{"text": "alpha", "active": False}]}
        self.assertEqual(filter_words("beta,, alpha", state, True), "beta")

    def test_imported_individual_weight(self):
        state = {"groups": [{"text": "alpha, beta", "active": True, "items": [{"text": "alpha", "active": True, "strength": 0.6}]}]}
        self.assertEqual(filter_words("alpha, beta", state, True), "(alpha:0.6), beta")


class TagFormatTests(unittest.TestCase):
    def test_normalizes_separators_spacing_and_duplicates(self):
        self.assertEqual(format_tags("1girl,  long   hair,\n(solo, smile:1.2),, 1Girl, "), "1girl, long hair, (solo, smile:1.2)")
        self.assertEqual(format_tags(" ,\n"), "")


class PromptOrderTests(unittest.TestCase):
    categories = read_categories("hatsune_miku,4,100,\nvocaloid,3,50,\nwlop,1,10,\nlong_hair,0,900,\ntranslated,5,5,\n")

    def test_join_respects_sentence_end(self):
        self.assertEqual(join_prompt("1girl, solo", "A girl smiles."), "1girl, solo, A girl smiles.")
        self.assertEqual(join_prompt("A girl smiles.", "1girl, solo"), "A girl smiles. 1girl, solo")
        self.assertEqual(join_prompt("", "only text"), "only text")

    def test_illustrious_order(self):
        text = "long hair, wlop, vocaloid, translated, hatsune miku, 1girl, (smile:1.2), masterpiece, solo, year 2024"
        self.assertEqual(
            order_illustrious(text, self.categories),
            "masterpiece, year 2024, 1girl, solo, hatsune miku, vocaloid, wlop, long hair, translated, (smile:1.2)",
        )
        self.assertEqual(order_illustrious("masterpiece, 1girl, long_hair", self.categories, quality_first=False), "1girl, long_hair, masterpiece")
        self.assertEqual(order_illustrious("(hatsune miku:1.1), 1girl", self.categories), "1girl, (hatsune miku:1.1)")
        self.assertEqual(order_illustrious("imonetstyle, masterpiece, long_hair", self.categories, quality_first=False), "long_hair, imonetstyle, masterpiece")


class MigrationTests(unittest.TestCase):
    def test_preserves_links_disabled_entries_and_original(self):
        workflow = {"nodes": [
            {"id": 1, "type": "Lora Loader (LoraManager)", "inputs": [{"name": "model", "link": 10}], "widgets_values": [{"version": 1}, "<lora:alpha:0.4>", [{"name": "alpha", "strength": 0.4, "active": False}]]},
            {"id": 2, "type": "TriggerWord Toggle (LoraManager)", "widgets_values": [True, True, True, [{"text": "(alpha:0.80)", "active": False, "strength": 0.8}], "alpha"]}], "links": [[11, 1, 2, 2, 0, "STRING"]]}
        original = copy.deepcopy(workflow)
        converted, count = convert_workflow(workflow)
        self.assertEqual(workflow, original)
        self.assertEqual(count, 2)
        self.assertEqual(converted["links"], workflow["links"])
        loader, toggle = converted["nodes"]
        self.assertFalse(json.loads(loader["widgets_values"][0])[0]["active"])
        state = json.loads(toggle["widgets_values"][0])
        self.assertEqual(state["groups"][0]["text"], "alpha")
        self.assertEqual(filter_words("alpha", state, True), "")

    def test_nested_subgraph_and_flat_child_choices(self):
        node = {"type": "TriggerWord Toggle (LoraManager)", "widgets_values": [False, True, False, [{"text": "alpha", "active": False}, {"text": "beta", "active": True}], "alpha, beta"]}
        workflow = {"definitions": {"subgraphs": [{"nodes": [node]}]}}
        converted, count = convert_workflow(workflow)
        state = json.loads(converted["definitions"]["subgraphs"][0]["nodes"][0]["widgets_values"][0])
        self.assertEqual(count, 1)
        self.assertEqual(filter_words("alpha, beta", state, True), "beta")

    def test_linked_text_requires_manual_conversion(self):
        with self.assertRaisesRegex(ValueError, "linked text"):
            convert_workflow({"nodes": [{"type": "Lora Loader (LoraManager)", "inputs": [{"name": "text", "link": 1}]}]})


if __name__ == "__main__":
    unittest.main()
