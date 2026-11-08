#!/usr/bin/env python3
"""Import an unverified AI workbook and audit literal source provenance, offline.

This module never calls an LLM, evaluates spreadsheet formulas, changes extraction
rules, or emits medical scoring. All offsets are Python Unicode code-point indexes.
Run with code/.venv/bin/python; openpyxl and pypdf are the only non-stdlib imports.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import date, datetime, timezone
import hashlib
import html
import json
from pathlib import Path
import re
import sys
from typing import Any

from openpyxl import load_workbook
from pypdf import PdfReader


CODE_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_WORKBOOK = CODE_ROOT / "evaluation/annotations/expert-handoff/20261103T170116+0800/材料/L01_L05医学视觉特征参考答案_待复核.xlsx"
DEFAULT_IR_DIR = CODE_ROOT / "docs/acceptance/s3/comparison-2026-11-02/runs/guarded-v4/reuse/docling-standard-cpu"
DEFAULT_DATA_DIR = CODE_ROOT / "evaluation/reference-drafts/2026-11-03-l01-l05"
DEFAULT_REPORT_DIR = CODE_ROOT / "docs/acceptance/s4/input-selection/ai-reference"
NUMBERED = re.compile(r"(?m)^[ \t]*(\d+)\.[ \t]+")
ELLIPSIS = re.compile(r"\.{3,}|…+")
POLICY = {
    "origin": "external_ai_user_supplied",
    "human_verified": False,
    "not_gold": True,
    "quality_evaluation_eligible": False,
    "medical_review_status": "pending",
    "human_annotator": None,
    "human_reviewer": None,
    "human_review_date": None,
    "user_declared_source": "用户明确说明：是我让其它AI所抽取的，你可以用作参考。",
    "medical_semantic_approval_performed": False,
    "allowed_use": "冻结模型输出后的字面来源保留与待复核分歧审阅",
    "forbidden_use": [
        "不得作为已批准gold或完整人工标注",
        "不得注入抽取prompt或据此定制筛选规则",
        "不得生成医学precision/recall/F1或把未列项作为负例、漏提真值",
        "表内完成、审核、阅读状态均为原始声明，不能升级人工或医学批准",
    ],
}
LIMITATIONS = [
    "仅核对字面及来源；不批准医学语义、收录边界、术语翻译、拆分归并或表格行列关系。",
    "只搜索S3 source blocks；结构层native_text不是原文引文，不用于生成字符锚点。",
    "S3顺序、PDF文本层、图中文字及表格结构未经人工保真核验；字面未匹配不等于原PDF没有该内容。",
    "空白匹配仅删除Unicode isspace字符（含断行）；不做大小写、标点、NFKC/NFKD、连字、连字符或翻译改写转换。",
    "源行间连接仅作检索视图；输出每个真实block内独立[start,end)片段，不为合成连接符生成offset。",
    "重复候选全部保留，页码声明不用于自动挑选重复位置。多片段、表格转录及省略号整体保持partial/ambiguous/unmatched。",
    "pypdf页文本是另一抽取视图，只作补充来源校验；其页内offset不冒充S3 block offset。",
]
EXPECTED_HEADERS = [
    "序号", "论文ID", "物理页码（从1起；多片段逐一标页）", "印刷页码（可空）",
    "段落/图表位置（逐片段对应）", "原文各片段（分行；保留原文）", "必要上下文",
    "特征原文名称", "内容类型建议（定义/观察/条件/待定）", "出处归属与引文编号（本研究/转引/共识/待定）",
    "病灶主体/人群", "模态与序列/期相", "否定/不确定性（保留原词）", "适用条件", "数值及单位（原样）",
    "收录/待裁定及理由", "重复/冲突/片段关联", "标注者", "复核者", "状态", "备注",
]


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def relative(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(CODE_ROOT))
    except ValueError:
        return str(path.resolve())


def jsonable(value: Any) -> Any:
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def text_value(cell: dict[str, Any] | None) -> str:
    if not cell or cell["data_type"] == "f":
        return ""
    return "" if cell["value"] is None else str(cell["value"])


def raw_workbook(path: Path) -> dict[str, Any]:
    book = load_workbook(path, read_only=True, data_only=False, keep_links=False)
    sheets = []
    declarations = []
    try:
        for sheet in book:
            rows = []
            count = 0
            max_col = 0
            for row_no, row in enumerate(sheet.iter_rows(), start=1):
                count = row_no
                cells = []
                for cell in row:
                    if cell.value is None:
                        continue
                    cells.append({"cell": cell.coordinate, "column": cell.column, "value": jsonable(cell.value),
                                  "data_type": cell.data_type, "formula_evaluated": False,
                                  "number_format": cell.number_format})
                    max_col = max(max_col, cell.column)
                    if cell.data_type != "f" and isinstance(cell.value, str) and any(
                            word in cell.value for word in ("人工", "医学复核", "审核", "AI辅助", "完成")):
                        declarations.append({"sheet": sheet.title, "cell": cell.coordinate, "raw_value": cell.value,
                                             "interpretation": "unverified_workbook_statement_only"})
                rows.append({"row": row_no, "cells": cells})
            nonempty = [row for row in rows if row["cells"]]
            # The reader index deliberately has a title before its actual row-5 header.
            header_row = 5 if sheet.title == "阅读索引" else (nonempty[0]["row"] if nonempty else None)
            headers = next((r["cells"] for r in rows if r["row"] == header_row), [])
            sheets.append({"sheet": sheet.title, "rows_read": count, "max_nonempty_column": max_col,
                           "nonempty_rows": len(nonempty), "header_row": header_row,
                           "headers": headers, "body_nonempty_rows": sum(r["row"] > header_row for r in nonempty) if header_row else 0,
                           "formula_count": sum(c["data_type"] == "f" for r in rows for c in r["cells"]), "rows": rows})
    finally:
        book.close()
    return {"schema_version": "ai-reference-workbook-1", "file": relative(path), "sha256": sha256(path),
            "formula_policy": "formulas_preserved_as_inert_strings_not_evaluated_or_followed",
            "missing_cells": "not_present_or_blank_in_workbook_no_values_imputed",
            "provenance": dict(POLICY), "sheets": sheets, "workbook_declarations": declarations}


def numbered_parts(value: str) -> list[dict[str, Any]]:
    """Preserve numbering and exact cell ranges; never infer sentence fragments."""
    matches = list(NUMBERED.finditer(value))
    if not matches:
        left = len(value) - len(value.lstrip())
        right = len(value.rstrip())
        return [{"number": None, "text": value[left:right], "cell_start": left, "cell_end": right,
                 "parser": "unlabelled_single_fragment"}] if right > left else []
    spans = []
    if value[:matches[0].start()].strip():
        prefix = value[:matches[0].start()]
        spans.append({"number": None, "text": prefix.strip(), "cell_start": len(prefix) - len(prefix.lstrip()),
                      "cell_end": len(prefix.rstrip()), "parser": "unlabelled_prefix_not_discarded"})
    for i, match in enumerate(matches):
        end = matches[i+1].start() if i+1 < len(matches) else len(value)
        raw = value[match.end():end]
        start = match.end() + len(raw) - len(raw.lstrip())
        stop = match.end() + len(raw.rstrip())
        spans.append({"number": int(match.group(1)), "text": value[start:stop], "cell_start": start,
                      "cell_end": stop, "parser": "explicit_numbered_fragment"})
    return spans


def locator_for(raw: str, number: int | None) -> tuple[str | None, list[str]]:
    parts = numbered_parts(raw)
    labelled = [part for part in parts if part["number"] == number]
    if len(labelled) == 1:
        return labelled[0]["text"], []
    if len(labelled) > 1:
        return None, ["duplicate_locator_number"]
    if number is None and len(parts) == 1 and parts[0]["number"] is None:
        return parts[0]["text"], []
    return None, ["no_unique_locator_for_fragment_number"]


def parse_page_claim(raw: str | None, page_count: int) -> tuple[int | None, list[str]]:
    if raw is None or not re.fullmatch(r"\s*[0-9]+\s*", raw):
        return None, ["missing_or_ambiguous_physical_page_claim"]
    page = int(raw)
    if not 1 <= page <= page_count:
        return None, ["physical_page_claim_out_of_range"]
    return page, []


def without_whitespace(value: str) -> tuple[str, list[int]]:
    positions = [i for i, char in enumerate(value) if not char.isspace()]
    return "".join(value[i] for i in positions), positions


def occurrences(haystack: str, needle: str):
    if not needle:
        return
    start = 0
    while (pos := haystack.find(needle, start)) >= 0:
        yield pos, pos + len(needle)
        start = pos + 1


def document_streams(document: dict[str, Any]) -> list[dict[str, Any]]:
    """Only consecutive source-order blocks on the same physical page are joined."""
    streams = []
    for page in document["pages"]:
        physical_page = page["physical_page"]
        page_blocks = sorted((b for b in document["blocks"] if b["page"] == physical_page), key=lambda b: b["reading_order"])
        chars = []
        spans = []
        cursor = 0
        for i, block in enumerate(page_blocks):
            if i:
                chars.append("\n")
                cursor += 1
            start = cursor
            chars.append(block["text"])
            cursor += len(block["text"])
            spans.append((start, cursor, block))
        text = "".join(chars)
        normalized, positions = without_whitespace(text)
        streams.append({"physical_page": physical_page, "text": text, "spans": spans,
                        "normalized": normalized, "positions": positions})
    return streams


def candidate_for(stream: dict[str, Any], start: int, end: int, method: str) -> dict[str, Any]:
    segments = []
    for a, b, block in stream["spans"]:
        left, right = max(a, start), min(b, end)
        if right <= left:
            continue
        seg_start, seg_end = left-a, right-a
        segments.append({"block_id": block["block_id"], "text_version": block["text_version"],
                         "physical_page": block["page"], "start": seg_start, "end": seg_end,
                         "text": block["text"][seg_start:seg_end], "bbox": block.get("bbox"),
                         "offset_unit": "unicode_code_point", "offset_interval": "[start,end)"})
    # A synthetic line separator cannot be called an exact character from a PDF block.
    if method == "exact" and len(segments) > 1:
        method = "whitespace_normalized"
    return {"method": method, "physical_page": stream["physical_page"], "source_segments": segments,
            "source_stream_text": stream["text"][start:end],
            "source_stream_definition": "source_order_blocks_joined_with_synthetic_newlines_for_search_only",
            "source_order_human_verified": False,
            "transformations": [] if method == "exact" else ["remove_unicode_whitespace_including_line_breaks_only"],
            "selected": False}


class LiteralMatcher:
    def __init__(self, document: dict[str, Any]):
        self.document = document
        self.streams = document_streams(document)
        self.blocks = {block["block_id"]: block for block in document["blocks"]}
        self.cache: dict[str, list[dict[str, Any]]] = {}

    def all_candidates(self, quote: str) -> list[dict[str, Any]]:
        if quote in self.cache:
            return self.cache[quote]
        candidates = {}
        normalized_quote, _ = without_whitespace(quote)
        for stream in self.streams:
            exact = list(occurrences(stream["text"], quote))
            positions = [(a, b, "exact") for a, b in exact]
            if normalized_quote:
                for a, b in occurrences(stream["normalized"], normalized_quote):
                    positions.append((stream["positions"][a], stream["positions"][b-1]+1, "whitespace_normalized"))
            for a, b, method in positions:
                candidate = candidate_for(stream, a, b, method)
                if not candidate["source_segments"]:
                    continue
                key = tuple((s["block_id"], s["start"], s["end"]) for s in candidate["source_segments"])
                if key not in candidates:  # Exact tier was visited first; keep exact on identical real intervals.
                    candidates[key] = candidate
        result = list(candidates.values())
        self.cache[quote] = result
        return result

    def match(self, quote: str, claimed_page: int | None) -> dict[str, Any]:
        # Copy containers because claim and selection are request-specific, not cache properties.
        candidates = [{**candidate, "matches_claimed_page": candidate["physical_page"] == claimed_page,
                       "selected": False} for candidate in self.all_candidates(quote)] if quote else []
        warnings = []
        selected = None
        if not quote.strip():
            status = "unmatched"
            warnings.append("empty_or_formula_evidence_not_matched")
        elif not candidates:
            status = "unmatched"
            warnings.append("no_literal_match_in_emitted_s3_source_blocks")
        elif len(candidates) > 1:
            status = "ambiguous"
            warnings.append("multiple_literal_source_candidates_no_first_occurrence_selected")
        elif claimed_page is None:
            status = "partial"
            warnings.append("physical_page_claim_unresolved_candidate_not_selected")
        elif candidates[0]["physical_page"] != claimed_page:
            status = "partial"
            warnings.append("physical_page_claim_conflicts_with_literal_source_candidate")
        else:
            candidates[0]["selected"] = True
            selected = candidates[0]
            status = "exact" if selected["method"] == "exact" else "normalized"
        if any(len(candidate["source_segments"]) > 1 for candidate in candidates):
            warnings.append("cross_source_line_match_backend_reading_order_unverified")
        if len(without_whitespace(quote)[0]) < 4:
            warnings.append("short_fragment_has_limited_localization_specificity")
        return {"status": status, "candidate_count": len(candidates), "candidates": candidates,
                "selected_source_segments": selected["source_segments"] if selected else [],
                "warnings": warnings}


def direct_pdf_matches(quote: str, page_texts: list[dict[str, Any]]) -> dict[str, Any]:
    candidates = []
    needle, _ = without_whitespace(quote)
    for page in page_texts:
        text = page["text"]
        intervals = {(a, b): "exact" for a, b in occurrences(text, quote)}
        normalized, positions = without_whitespace(text)
        if needle:
            for a, b in occurrences(normalized, needle):
                intervals.setdefault((positions[a], positions[b-1]+1), "whitespace_normalized")
        for (a, b), method in intervals.items():
            candidates.append({"physical_page": page["physical_page"], "start": a, "end": b,
                               "offset_unit": "unicode_code_point", "offset_interval": "[start,end)",
                               "offset_scope": "pypdf_extract_text_default_page_text",
                               "page_text_sha256": page["text_sha256"], "text": text[a:b], "method": method})
    return {"candidate_count": len(candidates), "candidates": candidates,
            "block_id": None, "used_to_invent_s3_source_segments": False,
            "meaning": "supplementary_text_layer_check_not_visual_or_medical_approval"}


def align_fragment(part: dict[str, Any], page_raw: str | None, location_raw: str | None,
                   matcher: LiteralMatcher, page_texts: list[dict[str, Any]]) -> dict[str, Any]:
    page, page_warnings = parse_page_claim(page_raw, len(matcher.document["pages"]))
    quote = part["text"]
    whole = matcher.match(quote, page)
    # Explicit worksheet separators are not interpreted as literal PDF characters.
    component_specs = []
    representation = "continuous_claim"
    if "|" in quote:
        representation = "explicit_pipe_delimited_table_transcription"
        component_specs = [(piece.strip(), "worksheet_pipe_delimited_cell") for piece in quote.split("|") if piece.strip()]
    elif ELLIPSIS.search(quote):
        representation = "explicit_ellipsis_noncontinuous_claim"
        component_specs = [(piece.strip(), "worksheet_ellipsis_delimited_piece") for piece in ELLIPSIS.split(quote) if piece.strip()]
    elif "\n" in quote and re.search(r"(?:表\s*\d|Table\s*\d)", location_raw or "", re.I):
        representation = "explicit_multiline_table_transcription"
        component_specs = [(piece.strip(), "worksheet_table_line") for piece in quote.splitlines() if piece.strip()]
    components = [{"component": i, "raw_text": piece, "split_basis": basis, "alignment": matcher.match(piece, page)}
                  for i, (piece, basis) in enumerate(component_specs, start=1)]
    status = whole["status"]
    warnings = list(page_warnings) + list(whole["warnings"])
    if component_specs:
        any_anchor = whole["candidate_count"] or any(c["alignment"]["candidate_count"] for c in components)
        status = "partial" if any_anchor else "unmatched"
        warnings.append("noncontinuous_or_table_transcription_not_promoted_to_contiguous_source_quote")
        # A real candidate may still be useful to a reviewer, but is never a selected table/ellipsis passage.
        whole["selected_source_segments"] = []
        for candidate in whole["candidates"]:
            candidate["selected"] = False
    if matcher.document["document_id"] == "L05" and re.search(r"[\u4e00-\u9fff]", quote):
        warnings.append("contains_chinese_in_english_paper_possible_gloss_not_accepted_as_translation_match")
    return {**part, "physical_page_claim_raw": page_raw, "claimed_physical_page": page,
            "location_claim_raw": location_raw, "representation": representation,
            "status": status, "whole_quote_alignment": whole, "components": components,
            "direct_pdf_text_check": direct_pdf_matches(quote, page_texts),
            "warnings": sorted(set(warnings))}


def row_cells(row: dict[str, Any]) -> dict[int, dict[str, Any]]:
    return {cell["column"]: cell for cell in row["cells"]}


def read_sources(ir_dir: Path, document_ids: list[str], pdf_dir: Path | None) -> tuple[dict[str, Any], dict[str, Any]]:
    sources, evidence = {}, {}
    for document_id in document_ids:
        if not re.fullmatch(r"[A-Za-z0-9_-]+", document_id):
            raise ValueError(f"Unsafe document ID: {document_id!r}")
        path = ir_dir / (document_id + ".json")
        raw = json.loads(path.read_text(encoding="utf-8"))
        document = raw.get("document", raw)
        if not document or document.get("document_id") != document_id:
            raise ValueError(f"IR document ID mismatch: {path}")
        if document.get("offset_unit") != "unicode_code_point" or document.get("offset_interval") != "[start,end)":
            raise ValueError(f"Unsupported offset contract: {path}")
        ids = [b["block_id"] for b in document["blocks"]]
        if len(ids) != len(set(ids)):
            raise ValueError(f"Duplicate source block IDs: {path}")
        valid_pages = {p["physical_page"] for p in document["pages"]}
        for block in document["blocks"]:
            if (block["document_id"] != document_id or block["text_version"] != document["text_version"] or
                    block["page"] not in valid_pages or not isinstance(block["text"], str)):
                raise ValueError(f"Invalid source block binding: {path}")
        pdf_path = (pdf_dir / (document_id + ".pdf")) if pdf_dir else CODE_ROOT / document["source"]["file_reference"]
        pdf_hash = sha256(pdf_path)
        if pdf_hash != document["file_sha256"]:
            raise ValueError(f"Original PDF hash does not match S3 IR: {pdf_path}")
        reader = PdfReader(str(pdf_path))
        if len(reader.pages) != len(document["pages"]):
            raise ValueError(f"Original PDF page count does not match S3 IR: {pdf_path}")
        pages = []
        for i, page in enumerate(reader.pages, start=1):
            page_text = page.extract_text() or ""
            pages.append({"physical_page": i, "text": page_text, "text_sha256": hashlib.sha256(page_text.encode("utf-8")).hexdigest(),
                          "offset_unit": "unicode_code_point", "offset_interval": "[start,end)", "human_fidelity_verified": False})
        sources[document_id] = {"document": document, "matcher": LiteralMatcher(document), "pdf_pages": pages}
        evidence[document_id] = {"document_id": document_id, "original_pdf": relative(pdf_path),
                                 "pdf_sha256_before": pdf_hash, "pdf_page_count": len(reader.pages),
                                 "ir_file": relative(path), "ir_sha256_before": sha256(path),
                                 "file_sha256_in_ir": document["file_sha256"], "text_version": document["text_version"],
                                 "raw_text_version": document.get("raw_text_version"), "source_blocks": len(ids),
                                 "source_code_points": sum(len(b["text"]) for b in document["blocks"]),
                                 "ir_structure_used_as_literal_quote": False, "human_source_fidelity_verified": False,
                                 "pdf_path_internal": pdf_path, "ir_path_internal": path}
    return sources, evidence


def import_entries(workbook: dict[str, Any], sources: dict[str, Any]) -> list[dict[str, Any]]:
    sheet = next((s for s in workbook["sheets"] if s["sheet"] == "逐条标注"), None)
    if sheet is None:
        raise ValueError("Workbook missing expected 逐条标注 sheet")
    headers = [text_value(c) for c in sheet["headers"]]
    if headers != EXPECTED_HEADERS:
        raise ValueError("逐条标注 headers differ from the audited import contract; update explicit mapping before importing")
    entries = []
    for row in sheet["rows"]:
        if row["row"] <= sheet["header_row"] or not row["cells"]:
            continue
        cells = row_cells(row)
        raw_fields = {EXPECTED_HEADERS[column-1]: cell for column, cell in cells.items() if column <= len(EXPECTED_HEADERS)}
        reference_id, document_id = text_value(cells.get(1)), text_value(cells.get(2))
        if not reference_id:
            raise ValueError(f"Nonempty annotation row missing literal ID at row {row['row']}")
        if document_id not in sources:
            raise ValueError(f"No explicit PDF/IR source for annotation {reference_id}: {document_id!r}")
        quote_raw = text_value(cells.get(6))
        page_raw = text_value(cells.get(3))
        location_raw = text_value(cells.get(5))
        parts = numbered_parts(quote_raw)
        fragments = []
        warnings = []
        for part in parts:
            page_claim, pw = locator_for(page_raw, part["number"])
            location_claim, lw = locator_for(location_raw, part["number"])
            source = sources[document_id]
            fragment = align_fragment(part, page_claim, location_claim, source["matcher"], source["pdf_pages"])
            fragment["warnings"] = sorted(set(fragment["warnings"] + pw + lw))
            fragments.append(fragment)
        if any(cell["data_type"] == "f" for column, cell in cells.items() if column in (1, 2, 3, 5, 6)):
            warnings.append("formula_in_evidence_or_locator_not_evaluated_or_matched")
        statuses = [f["status"] for f in fragments]
        if len(fragments) > 1:
            status = "partial" if any(s != "unmatched" for s in statuses) else "unmatched"
            warnings.append("multiple_explicit_fragments_not_concatenated_or_promoted_to_single_source_quote")
        else:
            status = statuses[0] if statuses else "unmatched"
        if len({f["number"] for f in fragments}) != len(fragments):
            status = "ambiguous"
            warnings.append("duplicate_fragment_number")
        entries.append({"reference_id": reference_id, "document_id": document_id, "provenance": dict(POLICY),
                        "worksheet": "逐条标注", "worksheet_row": row["row"], "quote_cell": f"F{row['row']}",
                        "raw_fields": raw_fields, "original_quote": quote_raw,
                        "locator_claims_raw": {"physical_pages": page_raw, "printed_pages": text_value(cells.get(4)), "locations": location_raw},
                        "feature_label_raw": text_value(cells.get(8)), "suggested_type_raw": text_value(cells.get(9)),
                        "inclusion_claim_raw": text_value(cells.get(16)), "association_or_conflict_raw": text_value(cells.get(17)),
                        "workbook_status_raw": text_value(cells.get(20)),
                        "human_annotator_raw": jsonable(cells.get(18, {}).get("value")),
                        "human_reviewer_raw": jsonable(cells.get(19, {}).get("value")),
                        "alignment_status": status, "fragments": fragments, "warnings": warnings})
    ids = [entry["reference_id"] for entry in entries]
    if len(ids) != len(set(ids)):
        raise ValueError("Duplicate workbook reference IDs; ambiguous row identity requires explicit resolution")
    return entries


def all_alignments(entry: dict[str, Any]):
    for f in entry["fragments"]:
        yield f["whole_quote_alignment"]
        for component in f["components"]:
            yield component["alignment"]


def independent_units(entry: dict[str, Any]):
    """Use explicit worksheet units; no silent prose splitting or table association."""
    for index, fragment in enumerate(entry["fragments"], start=1):
        base = {"fragment_index": index, "fragment_number": fragment["number"],
                "physical_page_claim_raw": fragment["physical_page_claim_raw"],
                "claimed_physical_page": fragment["claimed_physical_page"],
                "representation": fragment["representation"]}
        if fragment["components"]:
            for component in fragment["components"]:
                yield {**base, "component_index": component["component"], "raw_text": component["raw_text"],
                       "alignment": component["alignment"]}
        else:
            yield {**base, "component_index": None, "raw_text": fragment["text"],
                   "alignment": fragment["whole_quote_alignment"]}


def literal_coverage(entry: dict[str, Any]) -> dict[str, Any]:
    units = list(independent_units(entry))
    unique = sum(u["alignment"]["status"] in ("exact", "normalized") and bool(u["alignment"]["selected_source_segments"]) for u in units)
    ambiguous = sum(u["alignment"]["status"] == "ambiguous" for u in units)
    unresolved = sum(u["alignment"]["status"] == "partial" for u in units)
    no_anchor = sum(not u["alignment"]["candidate_count"] for u in units)
    all_unique = bool(units) and unique == len(units)
    if all_unique:
        category = "all_independent_units_uniquely_anchored"
    elif ambiguous:
        category = "contains_repeated_source_ambiguity"
    elif unique:
        category = "only_some_independent_units_uniquely_anchored"
    elif unresolved:
        category = "page_claim_conflict_or_unresolved"
    else:
        category = "no_independent_units_anchored"
    return {"category": category, "independent_units": len(units), "uniquely_anchored_units": unique,
            "ambiguous_units": ambiguous, "page_unresolved_units": unresolved, "no_literal_anchor_units": no_anchor,
            "all_independent_units_uniquely_anchored": all_unique,
            "row_eligible_for_fully_located_literal_comparison": all_unique,
            "requires_manual_scope_and_semantic_review": True,
            "meaning": "独立单元的字面定位统计，不批准表格行列、片段间关系或医学语义；无可靠定位的行单列，不当成0分。"}


def build_anchor_index(entries: list[dict[str, Any]], sources: dict[str, Any]) -> dict[str, Any]:
    records = []
    for entry in entries:
        units = []
        for unit_no, unit in enumerate(independent_units(entry), start=1):
            alignment = unit["alignment"]
            selected = alignment["selected_source_segments"]
            units.append({"unit_id": f"{entry['reference_id']}:unit-{unit_no}",
                          **{key:value for key,value in unit.items() if key != "alignment"},
                          "alignment_status": alignment["status"],
                          "usable_for_literal_block_retention": bool(selected) and alignment["status"] in ("exact", "normalized"),
                          "unique_source_segments": selected,
                          "all_candidate_source_block_id_sets": [list(dict.fromkeys(s["block_id"] for s in c["source_segments"])) for c in alignment["candidates"]],
                          "candidate_count": alignment["candidate_count"],
                          "medical_evaluation_eligible": False})
        unique_blocks = set(s["block_id"] for unit in units for s in unit["unique_source_segments"])
        order = {b["block_id"]:b["reading_order"] for b in sources[entry["document_id"]]["document"]["blocks"]}
        records.append({"reference_id": entry["reference_id"], "document_id": entry["document_id"],
                        "file_sha256": sources[entry["document_id"]]["document"]["file_sha256"],
                        "text_version": sources[entry["document_id"]]["document"]["text_version"],
                        "worksheet_row": entry["worksheet_row"], "quote_cell": entry["quote_cell"],
                        "alignment_status": entry["alignment_status"], "literal_coverage": entry["literal_coverage"],
                        "source_block_ids_for_input_retention": sorted(unique_blocks, key=lambda block_id: order[block_id]),
                        "units": units, "medical_evaluation_eligible": False})
    return {"schema_version": "ai-reference-anchor-index-1", "provenance": dict(POLICY),
            "block_set_semantics": "仅来自唯一且物理页声明一致的真实source区间；部分表格数值的定位不能代表整条记录已保留。",
            "unresolved_rows_separate_from_fully_located_literal_rows": True,
            "posthoc_comparison_owner": "t1_s4_filter_execution",
            "posthoc_comparison_status": "not_performed_by_importer_wait_for_frozen_rules_and_outputs",
            "records": records}


def validate_anchors(entries: list[dict[str, Any]], sources: dict[str, Any]) -> int:
    checked = 0
    for entry in entries:
        source = sources[entry["document_id"]]
        for fragment in entry["fragments"]:
            if entry["original_quote"][fragment["cell_start"]:fragment["cell_end"]] != fragment["text"]:
                raise ValueError(f"Workbook cell character range mismatch: {entry['reference_id']}")
            for alignment in [fragment["whole_quote_alignment"]] + [c["alignment"] for c in fragment["components"]]:
                for candidate in alignment["candidates"]:
                    for segment in candidate["source_segments"]:
                        block = source["matcher"].blocks[segment["block_id"]]
                        if not (0 <= segment["start"] < segment["end"] <= len(block["text"])):
                            raise ValueError(f"Source offset out of range: {entry['reference_id']}")
                        if (block["text"][segment["start"]:segment["end"]] != segment["text"] or
                                block["page"] != segment["physical_page"] or block["text_version"] != segment["text_version"]):
                            raise ValueError(f"Source anchor roundtrip mismatch: {entry['reference_id']}")
                        checked += 1
            for candidate in fragment["direct_pdf_text_check"]["candidates"]:
                text = source["pdf_pages"][candidate["physical_page"]-1]["text"]
                if text[candidate["start"]:candidate["end"]] != candidate["text"]:
                    raise ValueError(f"Direct PDF page offset roundtrip mismatch: {entry['reference_id']}")
    return checked


def build_issues(entries: list[dict[str, Any]], workbook: dict[str, Any]) -> dict[str, Any]:
    issues = []
    quote_groups: dict[tuple[str, str], list[str]] = {}
    for entry in entries:
        reasons = set(entry["warnings"])
        for fragment in entry["fragments"]:
            reasons.update(fragment["warnings"])
            if fragment["status"] in ("unmatched", "ambiguous", "partial"):
                reasons.add("fragment_" + fragment["status"])
            for component in fragment["components"]:
                reasons.update(component["alignment"]["warnings"])
        if entry["alignment_status"] not in ("exact", "normalized") or reasons:
            issues.append({"reference_id": entry["reference_id"], "document_id": entry["document_id"],
                           "worksheet_row": entry["worksheet_row"], "alignment_status": entry["alignment_status"],
                           "reasons": sorted(reasons), "workbook_association_or_conflict_raw": entry["association_or_conflict_raw"],
                           "medical_adjudication": "pending_not_performed"})
        quote_groups.setdefault((entry["document_id"], entry["original_quote"]), []).append(entry["reference_id"])
    repeated = [{"document_id": key[0], "reference_ids": ids,
                 "interpretation": "identical_workbook_quote_not_automatic_duplicate_or_medical_merge"}
                for key, ids in quote_groups.items() if len(ids) > 1]
    sheet = next((s for s in workbook["sheets"] if s["sheet"] == "争议与术语"), None)
    dispute_rows = []
    if sheet:
        for row in sheet["rows"]:
            if row["row"] > sheet["header_row"] and row["cells"]:
                dispute_rows.append({"worksheet": sheet["sheet"], "worksheet_row": row["row"], "cells": row["cells"],
                                     "origin": POLICY["origin"], "human_verified": False, "medical_adjudication": "pending_not_performed"})
    return {"schema_version": "ai-reference-issues-1", "provenance": dict(POLICY),
            "alignment_issues": issues, "repeated_workbook_quote_groups": repeated,
            "workbook_disputes_and_terms": dispute_rows}


def build_summary(entries: list[dict[str, Any]], workbook: dict[str, Any], issues: dict[str, Any]) -> dict[str, Any]:
    fragments = [f for e in entries for f in e["fragments"]]
    return {"schema_version": "ai-reference-summary-1", "provenance": dict(POLICY),
            "record_count": len(entries), "records_by_document": dict(Counter(e["document_id"] for e in entries)),
            "record_literal_alignment_status": dict(Counter(e["alignment_status"] for e in entries)),
            "record_independent_unit_coverage": dict(Counter(e["literal_coverage"]["category"] for e in entries)),
            "partial_record_breakdown": dict(Counter(e["literal_coverage"]["category"] for e in entries if e["alignment_status"] == "partial")),
            "partial_records_with_some_unanchored_units": sum(e["alignment_status"] == "partial" and e["literal_coverage"]["no_literal_anchor_units"] > 0 for e in entries),
            "partial_records_with_repeated_source_ambiguity": sum(e["alignment_status"] == "partial" and e["literal_coverage"]["ambiguous_units"] > 0 for e in entries),
            "fully_located_literal_comparison_rows": sum(e["literal_coverage"]["all_independent_units_uniquely_anchored"] for e in entries),
            "unresolved_rows_separate_not_scored_as_zero": sum(not e["literal_coverage"]["all_independent_units_uniquely_anchored"] for e in entries),
            "fragment_count": len(fragments), "fragment_literal_alignment_status": dict(Counter(f["status"] for f in fragments)),
            "worksheet_inventory": [{k: s[k] for k in ("sheet", "rows_read", "nonempty_rows", "header_row", "headers", "body_nonempty_rows", "formula_count")} for s in workbook["sheets"]],
            "formula_cells_preserved_not_evaluated": sum(s["formula_count"] for s in workbook["sheets"]),
            "nonempty_human_annotator_fields": sum(e["human_annotator_raw"] is not None for e in entries),
            "nonempty_human_reviewer_fields": sum(e["human_reviewer_raw"] is not None for e in entries),
            "workbook_dispute_rows": len(issues["workbook_disputes_and_terms"]),
            "repeated_workbook_quote_groups": len(issues["repeated_workbook_quote_groups"]),
            "counts_mean": "导入及字面来源映射统计，不能解释为医学质量或漏提真值。",
            "limitations": LIMITATIONS}


def report_html(summary: dict[str, Any], entries: list[dict[str, Any]], issues: dict[str, Any],
                preservation: dict[str, Any]) -> str:
    esc = lambda value: html.escape(str(value), quote=True)
    rendered = []
    for entry in entries:
        details = []
        for fragment in entry["fragments"]:
            fragments = []
            for label, alignment in [("整段", fragment["whole_quote_alignment"])] + [
                    (f"独立转录单元{c['component']}：{c['raw_text']}", c["alignment"]) for c in fragment["components"]]:
                candidates = []
                for candidate in alignment["candidates"]:
                    anchors = "<br>".join(
                        f"p{seg['physical_page']} {esc(seg['block_id'])} [{seg['start']},{seg['end']}) "
                        f"<code>{esc(seg['text'])}</code>" for seg in candidate["source_segments"])
                    candidates.append(f"<li>{esc(candidate['method'])}；页码声明符合={esc(candidate['matches_claimed_page'])}；"
                                      f"选定={esc(candidate['selected'])}<br>{anchors}</li>")
                fragments.append(f"<details><summary>{esc(label)} → {esc(alignment['status'])}（{alignment['candidate_count']}候选）</summary>"
                                 f"<ul>{''.join(candidates) or '<li>无字面锚点</li>'}</ul></details>")
            details.append(f"<div class='fragment'><p>片段{esc(fragment['number'])}；物理页声明：{esc(fragment['physical_page_claim_raw'])}；"
                           f"状态：{esc(fragment['status'])}</p><pre>{esc(fragment['text'])}</pre>"
                           f"<p>{esc('; '.join(fragment['warnings']))}</p>{''.join(fragments)}"
                           f"<p>独立pypdf页文本字面候选：{fragment['direct_pdf_text_check']['candidate_count']}（另存数据，不生成S3 block）</p></div>")
        raw_fields = {name: cell["value"] for name, cell in entry["raw_fields"].items()}
        coverage = entry["literal_coverage"]
        coverage_labels = {"all_independent_units_uniquely_anchored": "全部独立单元已有唯一锚点（表格/复合关系仍待核）",
                           "contains_repeated_source_ambiguity": "存在重复来源歧义（可能同时有未匹配单元）",
                           "only_some_independent_units_uniquely_anchored": "仅部分独立单元已有唯一锚点",
                           "page_claim_conflict_or_unresolved": "页码声明冲突或尚未确定", "no_independent_units_anchored": "独立单元暂未获字面定位"}
        rendered.append(f"<tr data-status='{esc(entry['alignment_status'])}'><td>{esc(entry['reference_id'])}<br>{esc(entry['document_id'])}<br>逐条标注!{esc(entry['quote_cell'])}</td>"
                        f"<td>{esc(entry['feature_label_raw'])}<br><strong>{esc(entry['alignment_status'])}</strong><br>"
                        f"{esc(coverage_labels[coverage['category']])}<br>独立单元{coverage['independent_units']}；唯一锚点{coverage['uniquely_anchored_units']}；"
                        f"歧义{coverage['ambiguous_units']}；无锚点{coverage['no_literal_anchor_units']}<br>医学复核：待办</td>"
                        f"<td>{''.join(details)}<details><summary>完整原始行（含上下文、收录理由、冲突）</summary><pre>{esc(json.dumps(raw_fields, ensure_ascii=False, indent=2))}</pre></details></td></tr>")
    dispute_html = []
    for row in issues["workbook_disputes_and_terms"]:
        dispute_html.append(f"<tr><td>{row['worksheet_row']}</td><td><pre>{esc(json.dumps({c['cell']:c['value'] for c in row['cells']}, ensure_ascii=False, indent=2))}</pre></td></tr>")
    sheet_rows = "".join(f"<tr><td>{esc(s['sheet'])}</td><td>{s['nonempty_rows']}</td><td>{s['header_row']}</td><td>{s['body_nonempty_rows']}</td><td>{s['formula_count']}</td></tr>" for s in summary["worksheet_inventory"])
    return f"""<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>L01/L05 AI参考草稿：字面来源校验</title><style>
body{{font:15px/1.6 system-ui,sans-serif;max-width:1450px;margin:24px auto;padding:0 18px;color:#182638}}h1{{font-size:25px}}h2{{font-size:19px;margin-top:26px}}
table{{border-collapse:collapse;width:100%}}th,td{{border:1px solid #b8c4d0;padding:9px;text-align:left;vertical-align:top}}th{{background:#eef3f7}}
pre{{white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0}}code{{white-space:pre-wrap;background:#f2f4f8}}.notice{{background:#fff1cb;border-left:5px solid #ba7c03;padding:14px}}.fragment{{border-top:1px solid #cbd5df;padding:6px 0}}summary{{cursor:pointer}}li{{margin:6px 0}}
</style><h1>L01/L05 AI参考草稿：字面来源校验</h1>
<p class="notice"><strong>外部AI草稿，人工与医学复核仍待办。不是gold，不能用于医学质量计分。</strong><br>
本报告仅检查Excel引文与原PDF/S3源锚点的字面关系。表内“完成/已读/已提取”等均保留为AI原始声明；所有姓名与人工日期均未补填。未列项不能视为负例或漏提真值。</p>
<p>导入{summary['record_count']}条：{esc(json.dumps(summary['records_by_document'],ensure_ascii=False))}。记录字面状态：{esc(json.dumps(summary['record_literal_alignment_status'],ensure_ascii=False))}；{summary['fragment_count']}个编号片段。参考记录的数量与拆并不代表金标数量，不能把exact/normalized条数解读为“正确条数”，或把其他状态解读为“错误”。</p>
<p>原Excel SHA256：<code>{esc(preservation['workbook']['sha256_before'])}</code>；只读前后哈希相同：<strong>{esc(preservation['all_inputs_unchanged'])}</strong>。表内{summary['formula_cells_preserved_not_evaluated']}个公式仅原样存储，未执行或跟随超链接。</p>
<h2>工作表清单</h2><table><tr><th>工作表</th><th>非空行</th><th>表头行</th><th>正文非空行</th><th>公式数</th></tr>{sheet_rows}</table>
<h2>如何读这些状态</h2><p>exact：连续字面匹配且物理页声明相符；normalized：仅删除明确列出的Unicode空白后相符；partial：多片段、表格重排、页码冲突或定位未定；ambiguous：存在多个字面来源候选，不挑第一处；unmatched：现有源文本未找到完整字面匹配。任何状态均不构成医学批准。</p>
<p>partial细分：{summary['partial_record_breakdown'].get('all_independent_units_uniquely_anchored',0)}条的全部独立单元均已有唯一锚点，但仍为复合/表格转录；
{summary['partial_record_breakdown'].get('only_some_independent_units_uniquely_anchored',0)}条仅部分单元有唯一锚点；
{summary['partial_records_with_repeated_source_ambiguity']}条含重复来源歧义（其中也可能有未匹配单元）。partial中共{summary['partial_records_with_some_unanchored_units']}条有尚无锚点的独立单元。</p>
<p>按全部独立单元可唯一定位口径，{summary['fully_located_literal_comparison_rows']}行可进入完整字面来源对照，另{summary['unresolved_rows_separate_not_scored_as_zero']}行单列为定位未决，不能强行按0分。该分组不是质量分母。
未匹配可受PDF文本层解析、特殊字形/标点、断行连字符、图片文字或引文改写影响；本工具未判定各条具体原因，也没有证明PDF不存在相关内容。</p>
<ul>{''.join('<li>'+esc(x)+'</li>' for x in LIMITATIONS)}</ul>
<h2>逐条来源审阅</h2><table><tr><th>记录与Excel定位</th><th>条目与字面状态</th><th>原文、定位及全部候选</th></tr>{''.join(rendered)}</table>
<h2>原表争议与术语（待复核）</h2><p>以下{len(dispute_html)}条原始AI建议未作医学裁定；查看完整结构化问题清单issues.json。</p><table><tr><th>原表行号</th><th>原始单元格</th></tr>{''.join(dispute_html)}</table>
<h2>比较接口边界</h2><p>仅在模型运行结果与通用筛选规则冻结后，使用reference-drafts.json中真实source_segments与输出的同版本来源区间做重叠审阅。分别列出“有来源重叠待语义核对”“草稿映射不完整/重复/页码冲突”“输出独有待人工判断”等，不计precision/recall/F1。参考表、中文释义及争议不得进入抽取prompt或规则生成。</p>
<p>source-anchor-index.json提供逐独立单元的唯一block集合与所有歧义候选集合。冻结条件的posthoc比较由t1_s4_filter_execution实现；本导入器未执行该比较。</p>
</html>"""


INTERFACE_TEXT = """离线AI参考草稿导入与比较接口

来源状态始终为external_ai_user_supplied；human_verified=false、not_gold=true、quality_evaluation_eligible=false。
原文件声明和姓名/日期原值在raw-workbook.json与reference-drafts.json原样保留；不代填人名/人工日期。

命令（在项目根目录）：
code/.venv/bin/python code/scripts/import-ai-reference.py
输出目录须不存在或为空，避免覆盖已有产物；重跑请显式指定新的--data-dir和--report-dir。
可选参数：--workbook PATH --ir-dir PATH --pdf-dir PATH --documents L01 L05 --data-dir PATH --report-dir PATH。
无模型API、无新依赖安装、无prompt或筛选规则写入。

数据：
raw-workbook.json：6个sheet所有读取行、非空单元格坐标/类型/值、公式原样字符串、原始声明。
reference-drafts.json：entries数组；reference_id与worksheet_row稳定引用原表。original_quote保留原值；
  fragments按显式编号拆分，cell_start/cell_end是original_quote的Unicode codepoint半开区间。
  fragments[].whole_quote_alignment.candidates[]列出所有S3字面候选，不自动挑重复位置；
  candidates[].source_segments[]含真实block_id/text_version/physical_page/start/end/text/bbox。
  仅连续唯一且页码声明一致的非表格片段可有selected_source_segments；所有source文本均可按IR切片复核。
  fragments[].components保留竖线表格单元、表格原始行或省略号独立片段。它们不代表已验证行列关系，
  整体保持partial，不能拼成连续sourcequote。多编号片段整体也保持partial。
  direct_pdf_text_check是pypdf页文本另一抽取视图，offset仅属于导出的pdf-page-texts.json对应页，不是S3 block。
issues.json：映射问题、重复原表引文组、原表18条争议/术语原值；无医学裁定。
summary.json：导入/字面匹配计数，非医学质量统计。
preservation.json：Excel、原PDF、IR只读前后SHA，页数、真实区间回读校验计数。
source-anchor-index.json：records按reference_id索引；source_block_ids_for_input_retention仅汇总唯一且页码相符的独立单元。
  units[].unique_source_segments为可追踪区间；all_candidate_source_block_id_sets保留每个候选，不自动选首处。
  literal_coverage标记全部独立单元唯一、部分唯一、重复来源歧义或无锚点；定位未决行单列，不强行打分。
  表格单独数值匹配不能视为整条保留，完整独立单元定位也不能批准行列、片段关系或医学语义。

冻结输出后的建议对照方式：
1. 先固定模型输出、通用用户目标筛选规则与运行证据，记录各自hash，再读取本草稿文件。
2. source interval相交须document_id/file_sha256/text_version/block_id一致，再比较[start,end)。
3. 为每条草稿保留其原ID、原引文、映射状态以及全部重叠输出ID；“有来源重叠”只表示保留了同源文字，
   不等于医学语义正确或所有片段已覆盖。只重叠一个表格数值也不能标为整条保留。
4. 按片段/独立表格单元列明完全覆盖、部分重叠、无区间重叠、映射未决、重复来源歧义与待医学复核分歧。
   ambiguous候选不得默认选第一处；unmatched不得按0分或模型遗漏处理。不要自动按词面归并医学条目。
5. 输出独有项保留待核；AI草稿未列项不能作为负例/漏提真值。禁止计算医学precision/recall/F1。
6. 本材料不能替代S2完整独立人工标注与医学复核；正式审查计数不因导入改变。

分工：本导入器只生成来源映射和审阅材料，未执行实际模型输出的posthoc比较。
实际规则/模型条件冻结后的输入保留与输出字面重合对照由t1_s4_filter_execution实现。
"""


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workbook", type=Path, default=DEFAULT_WORKBOOK)
    parser.add_argument("--ir-dir", type=Path, default=DEFAULT_IR_DIR)
    parser.add_argument("--pdf-dir", type=Path)
    parser.add_argument("--documents", nargs="+", default=["L01", "L05"])
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DATA_DIR)
    parser.add_argument("--report-dir", type=Path, default=DEFAULT_REPORT_DIR)
    args = parser.parse_args(argv)
    for path in (args.data_dir, args.report_dir):
        if path.exists() and (not path.is_dir() or any(path.iterdir())):
            parser.error(f"Refusing to overwrite existing nonempty output path: {path}")
    before = sha256(args.workbook)
    workbook = raw_workbook(args.workbook)
    sources, evidence = read_sources(args.ir_dir, args.documents, args.pdf_dir)
    entries = import_entries(workbook, sources)
    for entry in entries:
        entry["literal_coverage"] = literal_coverage(entry)
    anchor_index = build_anchor_index(entries, sources)
    checked = validate_anchors(entries, sources)
    issues = build_issues(entries, workbook)
    summary = build_summary(entries, workbook, issues)
    preservation = {"schema_version": "ai-reference-preservation-1", "generated_at": datetime.now(timezone.utc).isoformat(),
                    "importer": {"file": relative(Path(__file__)), "sha256": sha256(Path(__file__)), "python_version": sys.version.split()[0]},
                    "workbook": {"file": relative(args.workbook), "sha256_before": before,
                                 "sha256_after": sha256(args.workbook), "opened_read_only": True,
                                 "formulas_evaluated": False, "hyperlinks_followed": False}, "sources": {},
                    "validated_s3_source_segments": checked, "offset_roundtrip_validation": "passed",
                    "llm_calls": 0, "network_calls": 0, "medical_semantic_approval_performed": False}
    for document_id, source in evidence.items():
        pdf_path, ir_path = source["pdf_path_internal"], source["ir_path_internal"]
        preservation["sources"][document_id] = {k:v for k,v in source.items() if not k.endswith("_internal")}
        preservation["sources"][document_id].update({"pdf_sha256_after": sha256(pdf_path), "ir_sha256_after": sha256(ir_path)})
    preservation["all_inputs_unchanged"] = before == preservation["workbook"]["sha256_after"] and all(
        s["pdf_sha256_before"] == s["pdf_sha256_after"] and s["ir_sha256_before"] == s["ir_sha256_after"]
        for s in preservation["sources"].values())
    if not preservation["all_inputs_unchanged"]:
        raise ValueError("An input changed during read-only import; no report should be trusted")
    drafts = {"schema_version": "ai-reference-drafts-1", "provenance": dict(POLICY),
              "workbook_sha256": before, "source_documents": preservation["sources"], "limitations": LIMITATIONS,
              "entries": entries}
    args.data_dir.mkdir(parents=True, exist_ok=True)
    args.report_dir.mkdir(parents=True, exist_ok=True)
    for name, value in [("raw-workbook.json", workbook), ("reference-drafts.json", drafts), ("summary.json", summary),
                        ("issues.json", issues), ("preservation.json", preservation), ("source-anchor-index.json", anchor_index),
                        ("pdf-page-texts.json", {"schema_version": "ai-reference-pdf-page-texts-1", "extractor": "pypdf.extract_text_default",
                                                 "used_as_s3_source_text": False,
                                                 "documents": {name: {"pdf_sha256": evidence[name]["pdf_sha256_before"], "pages": source["pdf_pages"]}
                                                               for name, source in sources.items()}})]:
        write_json(args.data_dir / name, value)
    (args.report_dir / "report.html").write_text(report_html(summary, entries, issues, preservation), encoding="utf-8")
    (args.report_dir / "interface.txt").write_text(INTERFACE_TEXT, encoding="utf-8")
    write_json(args.report_dir / "summary.json", summary)
    write_json(args.report_dir / "preservation.json", preservation)
    print(json.dumps({"data_dir": relative(args.data_dir), "report": relative(args.report_dir / "report.html"),
                      "records": summary["record_count"], "by_document": summary["records_by_document"],
                      "literal_status": summary["record_literal_alignment_status"], "validated_source_segments": checked,
                      "all_inputs_unchanged": preservation["all_inputs_unchanged"], "not_gold": True}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
