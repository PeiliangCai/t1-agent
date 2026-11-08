#!/usr/bin/env python3
"""Focused safety/provenance checks for the offline AI reference importer."""
import importlib.util
from pathlib import Path
import unittest


spec = importlib.util.spec_from_file_location("ai_reference_import", Path(__file__).with_name("import-ai-reference.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def document(*pages):
    blocks = []
    for page, texts in enumerate(pages, start=1):
        for index, text in enumerate(texts):
            blocks.append({"block_id": f"D-p{page}-b{index}", "document_id": "D", "text_version": "v1", "text": text,
                           "page": page, "reading_order": len(blocks), "bbox": [0, 0, 1, 1]})
    return {"document_id": "D", "text_version": "v1", "pages": [{"physical_page": n+1} for n in range(len(pages))], "blocks": blocks}


class LiteralSourceTests(unittest.TestCase):
    def test_repeated_quote_keeps_all_candidates_even_with_page_claim(self):
        matcher = module.LiteralMatcher(document(["same quote", "same quote"], ["same quote"]))
        result = matcher.match("same quote", 1)
        self.assertEqual(result["status"], "ambiguous")
        self.assertEqual(result["candidate_count"], 3)
        self.assertEqual(result["selected_source_segments"], [])
        self.assertFalse(any(c["selected"] for c in result["candidates"]))

    def test_cross_line_whitespace_match_has_real_codepoint_offsets(self):
        doc = document(["🙂血管、", "血运丰富"])
        matcher = module.LiteralMatcher(doc)
        result = matcher.match("血管、血运丰富", 1)
        self.assertEqual(result["status"], "normalized")
        segments = result["selected_source_segments"]
        self.assertEqual([(s["start"], s["end"]) for s in segments], [(1, 4), (0, 4)])
        self.assertEqual("".join(s["text"] for s in segments), "血管、血运丰富")
        self.assertEqual(segments[0]["offset_unit"], "unicode_code_point")

    def test_numbered_multiline_keeps_cell_ranges_and_independent_fragments(self):
        raw = "1. First sentence\ncontinued.\n2. Second fragment"
        parts = module.numbered_parts(raw)
        self.assertEqual(len(parts), 2)
        self.assertEqual(parts[0]["text"], "First sentence\ncontinued.")
        for part in parts:
            self.assertEqual(raw[part["cell_start"]:part["cell_end"]], part["text"])
        self.assertEqual(module.locator_for("1. 2\n2. 3", 2), ("3", []))

    def test_multi_fragment_entry_stays_partial_and_index_separates_ambiguity(self):
        doc = document(["alpha source", "beta source", "same number 18/1", "again 18/1"])
        matcher = module.LiteralMatcher(doc)
        cells = [{"cell": f"X{i}", "column": i, "data_type": "s", "value": value}
                 for i, value in [(1,"D-001"), (2,"D"), (3,"1. 1\n2. 1"), (5,"1. paragraph\n2. paragraph"),
                                  (6,"1. alpha source\n2. beta source")]]
        workbook = {"sheets": [{"sheet":"逐条标注", "header_row":1,
                               "headers":[{"data_type":"s", "value":h} for h in module.EXPECTED_HEADERS],
                               "rows":[{"row":2, "cells":cells},
                                       {"row":3, "cells":[{"cell":f"X{i}", "column":i, "data_type":"s", "value":v}
                                                          for i,v in [(1,"D-002"),(2,"D"),(3,"1. 1"),(5,"1. paragraph"),(6,"1. 18/1")]]}]}]}
        sources = {"D":{"document":{**doc,"file_sha256":"a"*64}, "matcher":matcher, "pdf_pages":[]}}
        entries = module.import_entries(workbook, sources)
        entry = entries[0]
        self.assertEqual(entry["alignment_status"], "partial")
        self.assertEqual([f["status"] for f in entry["fragments"]], ["exact","exact"])
        for item in entries:
            item["literal_coverage"] = module.literal_coverage(item)
        indexes = module.build_anchor_index(entries,sources)["records"]
        index = indexes[0]
        self.assertTrue(index["literal_coverage"]["all_independent_units_uniquely_anchored"])
        self.assertEqual(index["source_block_ids_for_input_retention"], ["D-p1-b0","D-p1-b1"])
        self.assertEqual(len(index["units"]),2)
        self.assertEqual(indexes[1]["source_block_ids_for_input_retention"], [])
        self.assertEqual(indexes[1]["units"][0]["candidate_count"],2)
        self.assertEqual(indexes[1]["units"][0]["all_candidate_source_block_id_sets"], [["D-p1-b2"],["D-p1-b3"]])

    def test_table_cells_never_become_contiguous_source_quote(self):
        doc = document(["Diameter", "12 mm", "9 mm"])
        fragment = module.align_fragment({"number": 1, "text": "Diameter | 12 mm | 9 mm", "cell_start": 0,
                                          "cell_end": 26}, "1", "表2，列顺序转录", module.LiteralMatcher(doc), [])
        self.assertEqual(fragment["status"], "partial")
        self.assertEqual(len(fragment["components"]), 3)
        self.assertEqual(fragment["whole_quote_alignment"]["selected_source_segments"], [])
        self.assertTrue(all(c["alignment"]["status"] == "exact" for c in fragment["components"]))

    def test_paraphrase_translation_and_hyphen_rewrite_are_not_literal(self):
        matcher = module.LiteralMatcher(document(["The nodule diameter was 12 mm.", "consoli-", "dation"]))
        for text in ["The lesion measured twelve millimeters.", "结节直径为12毫米。", "consolidation"]:
            self.assertEqual(matcher.match(text, 1)["status"], "unmatched")

    def test_page_conflict_does_not_select_candidate(self):
        matcher = module.LiteralMatcher(document(["one"], ["unique quote"]))
        result = matcher.match("unique quote", 1)
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["selected_source_segments"], [])
        self.assertIn("physical_page_claim_conflicts_with_literal_source_candidate", result["warnings"])
        self.assertIsNone(module.parse_page_claim("2/3", 3)[0])

    def test_formula_is_inert_and_not_matched(self):
        self.assertEqual(module.text_value({"data_type": "f", "value": '=HYPERLINK("https://invalid","x")'}), "")

    def test_ellipsis_keeps_noncontinuous_parts_partial(self):
        matcher = module.LiteralMatcher(document(["alpha text", "unrelated middle", "omega text"]))
        fragment = module.align_fragment({"number": 1, "text": "alpha text … omega text", "cell_start": 0,
                                          "cell_end": 23}, "1", "paragraph", matcher, [])
        self.assertEqual(fragment["status"], "partial")
        self.assertEqual(len(fragment["components"]), 2)
        self.assertEqual(fragment["whole_quote_alignment"]["selected_source_segments"], [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
