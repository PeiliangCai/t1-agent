from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path

import openpyxl

CODE = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("output_review_workbook", CODE / "scripts/lib/output-review-workbook.py")
MOD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MOD)


class ReviewWorkbookTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="review-workbook-test-", dir=CODE / "runtime-data")
        self.path = Path(self.temp.name) / "test.xlsx"
        self.long_literal = '=1+1 & <literal> "quote"\n' + "原文😀×100" * 10000
        parts = MOD.literal_chunks(self.long_literal)
        self.sheets = [
            {"name": "随机测试", "headers": ["记录ID", "版本"] + [label for _, label in MOD.MANUAL],
             "rows": [[MOD.cell("record-fixture"), MOD.cell("2")] + MOD.manual_cells()],
             "widths": [20] * (2 + len(MOD.MANUAL))},
            {"name": "原文与出处", "headers": [f"字段{i}" for i in range(10)],
             "rows": [[MOD.cell(f"fragment-part-{i}")] + [MOD.cell("")] * 8 + [MOD.cell(text)] for i, text in enumerate(parts)],
             "widths": [20] * 10},
        ]
        MOD.write_workbook(self.sheets, self.path)

    def tearDown(self):
        self.temp.cleanup()

    def test_long_formula_like_original_is_literal_and_roundtrips_without_truncation(self):
        report = MOD.inspect_workbook(self.sheets, self.path)
        self.assertTrue(report["all_manual_fields_blank"])
        self.assertEqual(report["random_signed_complete_rows"], 0)
        self.assertFalse(report["product_export_approved"])
        book = openpyxl.load_workbook(self.path, data_only=False)
        rows = list(book["原文与出处"].iter_rows(min_row=2))
        self.assertEqual("".join(row[9].value for row in rows), self.long_literal)
        self.assertTrue(all(row[9].data_type == "s" for row in rows))
        self.assertTrue(all(len(row[9].value.encode("utf-16-le")) // 2 <= 32000 for row in rows))
        book.close()

    def test_source_text_or_record_version_tampering_is_refused(self):
        for name, address in [("随机测试", "B2"), ("原文与出处", "J2")]:
            book = openpyxl.load_workbook(self.path)
            before = book[name][address].value
            book[name][address] = "tampered"
            book.save(self.path); book.close()
            with self.assertRaisesRegex(ValueError, "bound_content_changed"):
                MOD.inspect_workbook(self.sheets, self.path)
            book = openpyxl.load_workbook(self.path); book[name][address] = before; book.save(self.path); book.close()

    def test_ooxml_controls_and_literal_escape_sequences_remain_distinct(self):
        text = "3.2 \x07Correlation\rnext\n" + "literal _x0007_ / _x005F_ / _x000D_ 😀"
        spec = [{"name": "原文与出处", "headers": [f"字段{i}" for i in range(10)],
                 "rows": [[MOD.cell("F-fixture"), MOD.cell("synthetic-only")] + [MOD.cell("")] * 7 + [MOD.cell(text)]],
                 "widths": [20] * 10}]
        path = Path(self.temp.name) / "escaped.xlsx"
        MOD.write_workbook(spec, path)
        raw = MOD.raw_string_cells(path)[("原文与出处", "J2")]
        self.assertEqual(raw["decoded"], text)
        self.assertIn("_x0007_", raw["raw"])
        self.assertIn("_x005F_x0007_", raw["raw"])
        report = MOD.inspect_workbook(spec, path)
        self.assertEqual(report["ooxml_decoded_control_cells"], 1)
        self.assertTrue(report["ooxml_control_diagnostics"][0]["exact_equality_after_single_pass_ooxml_decode"])

    def test_unsigned_or_partial_sheet_never_counts_as_completed_review(self):
        book = openpyxl.load_workbook(self.path)
        row = book["随机测试"]
        for i, key in enumerate(MOD.CHECKS, 3):
            row.cell(2, i, "通过")
        book.save(self.path); book.close()
        result = MOD.inspect_workbook(self.sheets, self.path)
        self.assertEqual(result["random_signed_complete_rows"], 0)
        self.assertEqual(len(result["incomplete_rows"]), 1)
        self.assertIn("reviewer", result["incomplete_rows"][0]["missing"])
        self.assertFalse(result["product_export_approved"])
        # Even a user-supplied signed fixture only records workbook completion; it grants no product approval.
        book = openpyxl.load_workbook(self.path)
        book["随机测试"].cell(2, 13, "synthetic-test-only")
        book["随机测试"].cell(2, 14, "2026-11-05T15:30:00+08:00")
        book.save(self.path); book.close()
        result = MOD.inspect_workbook(self.sheets, self.path)
        self.assertEqual(result["random_signed_complete_rows"], 1)
        self.assertFalse(result["medical_quality_approved"])
        self.assertEqual(result["application_review_events_written"], 0)

    def test_text_not_applicable_and_actual_formulas_are_refused(self):
        book = openpyxl.load_workbook(self.path)
        book["随机测试"]["C2"] = "不适用"
        book.save(self.path); book.close()
        with self.assertRaisesRegex(ValueError, "judgment_invalid"):
            MOD.inspect_workbook(self.sheets, self.path)
        book = openpyxl.load_workbook(self.path)
        book["随机测试"]["C2"] = None
        book["随机测试"]["L2"] = '=HYPERLINK("https://example.invalid","fixture")'
        book.save(self.path); book.close()
        with self.assertRaisesRegex(ValueError, "formula_refused"):
            MOD.inspect_workbook(self.sheets, self.path)


if __name__ == "__main__":
    unittest.main()
