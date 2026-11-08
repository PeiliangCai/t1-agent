"""Offline XLSX rendering / readback. Never writes an application approval or database."""
from __future__ import annotations

import hashlib
import json
import re
import sys
from datetime import datetime
from pathlib import Path
from zipfile import ZipFile
from xml.etree import ElementTree as ET
import posixpath

import openpyxl
import xlsxwriter


MANUAL = [
    ("pdf_fidelity", "原PDF一致性〔人工〕"),
    ("relevance", "目标视觉描述相关性〔人工〕"),
    ("clinical_context", "否定/不确定/病例/条件/数值语境〔人工〕"),
    ("attribution", "证据归属〔人工〕"),
    ("figure_pairing", "图文明确匹配〔人工〕"),
    ("figure_completeness", "整图完整〔人工〕"),
    ("canonical_group", "人工重复组"),
    ("issue_categories", "问题类别"),
    ("correction_proposal", "缺陷修订意见〔非原文〕"),
    ("notes", "人工备注"),
    ("reviewer", "核验人"),
    ("reviewed_at", "核验时间〔ISO8601含时区〕"),
]
CHECKS = [key for key, _ in MANUAL[:6]]
TEXT_OPTIONS = ["通过", "问题", "待核"]
FIGURE_OPTIONS = TEXT_OPTIONS + ["不适用"]
RISK_OPTIONS = ["问题成立", "不成立", "待核"]
FIELD_LABELS = {"disease_or_lesion": "疾病/病灶", "sequence_or_phase": "成像序列/期相",
                "numeric_expressions": "结构化数值", "review_status": "自动待核状态", "automatic_issue_codes": "自动待核提示"}
ISSUE_LABELS = {
    "numeric_expression_missing": "结构化数值缺失待核", "new_term_pending_human_review": "新表述待人核",
    "cross_block_field_relationship_requires_review": "跨源行字段归属待核", "sequence_or_phase_not_grounded_in_source": "序列/期相未获源文支持",
    "coreference_requires_context": "指代语境待核", "assertion_requires_context": "断言语境待核",
    "assertion_uncertainty_mismatch": "不确定性表述待核", "source_attribution_requires_review": "证据归属待核",
    "disease_or_lesion_not_grounded_in_source": "疾病/病灶归属待核", "nonadjacent_source_segments_require_context": "非相邻片段语境待核",
    "includes_whole_source_line_quotes_not_minimal_feature_spans": "整行引用范围待核",
}


def cell(value="", *, link=None, manual=None, options=None, comment=None):
    return {"v": str(value) if value is not None else "", "link": link,
            "manual": manual, "options": options, "comment": comment}


def literal_chunks(text: str, size: int = 16000) -> list[str]:
    """At most 32000 UTF-16 units per cell, even when every code point is astral."""
    return [text[i:i + size] for i in range(0, len(text), size)] or [""]


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def control_characters(text):
    return [{"code_point_offset": i, "unicode": f"U+{ord(c):04X}"} for i, c in enumerate(text)
            if ord(c) < 32 and c not in "\t\n\r" or ord(c) in (0xFFFE, 0xFFFF)]


def decode_ooxml_text(text):
    # OOXML uses one-pass _xHHHH_ escapes; _x005F_x0007_ means literal _x0007_.
    # Decoding openpyxl's already-unescaped value would lose that distinction.
    decoded = re.sub(r"_x([0-9A-Fa-f]{4})_", lambda m: chr(int(m[1], 16)), text)
    return decoded.encode("utf-16-le", "surrogatepass").decode("utf-16-le")


def raw_string_cells(path):
    """Read the actual OOXML string representation, before openpyxl normalizes it."""
    ns = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    rel_ns = {"r": "http://schemas.openxmlformats.org/package/2006/relationships"}
    strings = {}
    with ZipFile(path) as archive:
        def texts(node):
            return "".join(t.text or "" for t in node.findall(".//s:t", ns))
        shared = []
        if "xl/sharedStrings.xml" in archive.namelist():
            shared = [texts(node) for node in ET.fromstring(archive.read("xl/sharedStrings.xml")).findall("s:si", ns)]
        rels = {n.attrib["Id"]: n.attrib["Target"] for n in ET.fromstring(archive.read("xl/_rels/workbook.xml.rels")).findall("r:Relationship", rel_ns)}
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        for sheet in workbook.findall("s:sheets/s:sheet", ns):
            rel_id = sheet.attrib["{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"]
            target = rels[rel_id]
            member = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join("xl", target))
            root = ET.fromstring(archive.read(member))
            for node in root.findall(".//s:sheetData/s:row/s:c", ns):
                if node.attrib.get("t") == "s":
                    raw = shared[int(node.find("s:v", ns).text)]
                elif node.attrib.get("t") == "inlineStr":
                    raw = texts(node)
                else:
                    continue
                strings[(sheet.attrib["name"], node.attrib["r"])] = {"decoded": decode_ooxml_text(raw), "raw": raw}
    return strings


def manual_cells(risk=False):
    result = [cell(manual="risk_assessment", options=RISK_OPTIONS)] if risk else []
    return result + [cell(manual=k, options=(FIGURE_OPTIONS if k.startswith("figure_") else TEXT_OPTIONS) if k in CHECKS else None) for k, _ in MANUAL]


def view_status(view):
    fields = view["fields"]
    status = {"needs_context": "语境待核", "pending": "待核", "provided": "已附上下文，尚未人核"}
    automatic = {"passed": "程序一致检查通过，尚未人核", "requires_review": "程序提示待核"}
    return (f"候选：{status.get(fields['review_status'], fields['review_status'])}；"
            f"语境：{status.get(fields['context_status'], fields['context_status'])}；"
            f"{automatic.get(fields['automatic_checks_status'], fields['automatic_checks_status'])}\n"
            + "；".join(ISSUE_LABELS.get(code, code) for code in fields["automatic_issue_codes"]))


def change_value(field, value):
    if field in ("disease_or_lesion", "sequence_or_phase"):
        if value is None or value.get("value") is None:
            return "未确定/未知"
        return str(value["value"]) + "〔程序已定位；医学归属未核〕"
    if field == "numeric_expressions":
        return "；".join(n["original_text"] + (f" / 单位：{n['unit_original']}" if n.get("unit_original") else "") for n in value) or "字段为空〔不表示原文数字消失〕"
    if field == "review_status":
        return {"needs_context": "语境待核", "pending": "待核"}.get(value, value) + f"〔{value}；非人审〕"
    if field == "automatic_issue_codes":
        return "；".join(ISSUE_LABELS.get(code, code) for code in value) or "无自动提示〔仍未人核〕"
    return compact(value)


def view_binding(view):
    return [cell(view["record_id"]), cell(view["record_version"]),
            cell(view["source_record_sha256"]), cell(view["text_fingerprint"]),
            cell(view["delivery_fingerprint"]), cell(view["result_sha256"]),
            cell(view["file_sha256"]), cell(view["text_version"])]


def build_sheets(pack):
    fragments = pack["fragments"]
    source_rows = []
    first_source = {}
    for f in fragments:
        first_source.setdefault((f["owner_id"], f["arm"]), len(source_rows) + 2)
        parts = literal_chunks(f["exact_quote"])
        for part, text in enumerate(parts, 1):
            source_rows.append([
                cell(f["fragment_id"]), cell(f["owner_id"]), cell(f["arm"]), cell(f["role"]),
                cell(f["ordinal"]), cell(f"{part}/{len(parts)}"), cell(f["document_id"]),
                cell(f["physical_page"], link=f"external:{f['pdf_path']}#page={f['physical_page']}"),
                cell(f["source_type"]), cell(text, comment=("此源解析片段含控制字符：" + compact(control_characters(text)) + "。原字符保留，以OOXML转义写入，未删除/替换；请回看PDF核对解析忠实性。") if control_characters(text) else None), cell(f["block_id"]), cell(f["start"]), cell(f["end"]),
                cell(compact(f["bbox"])), cell(f["location_precision"]),
                cell("；".join(f["source_structure"])), cell(f["text_version"]), cell(f["file_sha256"]),
            ])
    binding_headers = ["记录ID", "记录版本", "源记录SHA-256", "文字fingerprint", "交付fingerprint",
                       "结果文件SHA-256", "源PDF SHA-256", "文本版本"]
    random_headers = ["样本号〔点击打开完整索引〕", "实际任务", "实际方法〔非盲审〕", "物理页", "独立原文与上下文〔点击〕",
                      "机器源类型〔未人核〕", "机器相同片段组〔非医学去重〕", "首轮同组条数与真实归属",
                      "图文状态〔自动未人核〕", "模型字段与自动待核提示〔不是人审〕"] + [label for _, label in MANUAL] + binding_headers
    random_rows = []
    for sample in pack["random_samples"]:
        view = sample["view"]
        source_row = first_source[(sample["id"], "baseline")]
        occurrences = sample["duplicate_occurrences"]
        row = [cell(sample["id"], link=f"external:review.html#{sample['id']}"), cell(sample["job_id"]), cell(sample["method"]),
               cell("、".join(map(str, view["physical_pages"]))),
               cell("打开独立片段；上下文另行", link=f"internal:'原文与出处'!A{source_row}"),
               cell("；".join(view["source_types"])), cell(sample["exact_fragment_group"]),
               cell(f"首轮{len(occurrences)}条；任务：" + "、".join(dict.fromkeys(o["job_id"] for o in occurrences)) + "\n本表同组：" + "、".join(s["id"] for s in pack["random_samples"] if s["exact_fragment_group"] == sample["exact_fragment_group"])),
               cell(view["figure_status_label"]), cell(view_status(view))] + manual_cells() + view_binding(view)
        random_rows.append(row)
    risk_headers = ["风险号〔点击打开实验详情〕", "实际任务/方法", "版本范围〔与随机分开〕", "物理页", "定向风险说明〔待人工判断〕",
                    "before实验字段", "after实验字段", "独立原文与上下文〔点击〕", "相同ID的随机样本〔另版本〕",
                    "before版本/源记录SHA/交付fingerprint", "after版本/源记录SHA/交付fingerprint", "人工风险判断"] + [label for _, label in MANUAL] + [
                    "记录ID", "before结果SHA-256", "after结果SHA-256", "源PDF SHA-256", "文本版本"]
    risk_rows = []
    for risk in pack["risks"]:
        before, after = risk["before"], risk["after"]
        source_row = first_source[(risk["id"], "before")]
        old = "\n".join(f"{FIELD_LABELS.get(c['field'], c['field'])}：{change_value(c['field'], c['before'])}" for c in risk["changes"])
        new = "\n".join(f"{FIELD_LABELS.get(c['field'], c['field'])}：{change_value(c['field'], c['after'])}" for c in risk["changes"])
        row = [cell(risk["id"], link=f"external:review.html#{risk['id']}"), cell(f"{risk['job_id']} / {risk['method']}"),
               cell("汇总单因素实验before/after；不是baseline；不计入30条随机统计"),
               cell("、".join(map(str, before["physical_pages"]))), cell("\n".join(risk["reasons"])), cell(old), cell(new),
               cell("打开before/after独立片段", link=f"internal:'原文与出处'!A{source_row}"),
               cell("、".join(risk["baseline_random_ids"]) or "无重叠"),
               cell(f"v{before['record_version']}\n{before['source_record_sha256']}\n{before['delivery_fingerprint']}"),
               cell(f"v{after['record_version']}\n{after['source_record_sha256']}\n{after['delivery_fingerprint']}")] + manual_cells(risk=True) + [
               cell(before["record_id"]), cell(before["result_sha256"]), cell(after["result_sha256"]), cell(before["file_sha256"]), cell(before["text_version"])]
        # Long metadata is kept complete in the HTML/manifest. Refuse a workbook overflow rather than truncating.
        risk_rows.append(row)
    instructions = [
        ("用途与数量", f"用户选定开发筛查：{len(pack['random_samples'])}条随机工作样本＋{len(pack['risks'])}条定向实验风险。人核0，医学批准0，产品批准0；正式样本量与阈值未冻结。"),
        ("先操作", "先完整解压ZIP，保持核验表.xlsx、review.html和pdf/figures目录的相对位置。先打开核验表.xlsx的说明页，再做30条随机样本，实验风险另表填写；只填黄色人工栏。点击样本号可开完整离线索引；原文定位列可跳本工作簿原文页。"),
        ("方法与抽样", "每个实际运行按固定可复现方法随机抽6条。真实方法明示：B0为单独智能体，F为正向规则选块＋智能体，R为反向删减无关块＋智能体；不称盲审。"),
        ("论文与重复", "仅2篇开发论文、5次实际提取。L01-R复用L01-F，没有第6次独立提取或额外6条。同论文的不同方法及重复证据并不独立，不能把30条当成30个独立医学事实。机器相同片段组仅表示原文相同，人工重复组另填。"),
        ("如何查原文", "逐条打开原PDF标示的物理页，核对原文、阅读顺序、表头/表行/图注、必要否定、不确定、病例、条件、数值单位和证据归属。PDF物理页从1开始，可能与印刷页码不同；链接页锚被阅读器忽略时按物理页手动定位。"),
        ("片段与上下文", "原文分段显示；同一片段的连续部分按序读取，不同片段不能拼成连续原句。提取原文、记录上下文和原图注分别标明，不改写、不翻译。正文/表格/图注类型及模型标签仍需人工核对。"),
        ("控制字符与显示", "部分解析文本含控制字符，查看器可能显示为空白或转义串。本包保留原始文本，请回看PDF原页核对，不能把控制字符当成已确认的论文文字。实际Office/各表格软件的视觉显示尚未实机验证。"),
        ("图文与整图", "包内仅1份原Fig.4资产；配图、整幅Figure/全部面板和原图注需要分别核。机械检查通过不是人工通过；无显式关联、未检查、待核均不代表论文无图。其他条目请回看PDF原页，不猜配、不裁病灶。"),
        ("填写判断", "原PDF、相关性、必要语境、证据归属为必核文本项，只能填通过/问题/待核，不能用不适用跳过。图片维度经实际查看确无需核验时才可填不适用；不适用不算图片通过。已看但无法判断请选择待核，尚未查保持空白。原文/出处栏不要手改。"),
        ("核验人和时间", "由实际核验人填写姓名及核验时间；时间示例：2026-11-05T15:30:00+08:00。未填写或未核清楚不能算审核通过。"),
        ("重复与缺陷", "人工重复组用于你认定的同一医学证据；问题类别可写原文不一致、无视觉描述、语境丢失、病例/条件混淆、数值/单位、转引归属、图文错配、整图不全、其他。医学修订意见与原文分开。"),
        ("实验风险另核", "5条风险来自汇总实验：Fig.4三条疾病/期相/数值字段变化，另有两条自动待核状态变化。它们与随机样本不是同一版本，前后实验结果分开看，不混入30条随机统计，也不把实验差异改回首轮输出。"),
        ("未核不批准", "本包仅供开发筛查，未填、待核或抽样结论均不能批准产品已审核导出；产品仍须逐条确认当前内容，文字批准不批准图片。不据此推断医学准确率、全文召回、零错误或赢家；不需要预制完整参考答案。"),
        ("完整离线索引", "review.html"),
        ("另存回交", "填写后另存为核验表-已填写.xlsx并交回，保留ZIP中的空白原模板。若有多份副本，请明确最终人工版本；原文与出处栏保持原样。"),
    ]
    info_rows = [[cell(k), cell(v, link="external:review.html" if k == "完整离线索引" else None)] for k, v in instructions]
    return [
        {"name": "说明", "headers": ["项目", "说明"], "rows": info_rows, "widths": [25, 125], "freeze": (1, 0)},
        {"name": "30条随机样本", "headers": random_headers, "rows": random_rows,
         "widths": [19, 14, 28, 10, 25, 24, 27, 46, 30, 48] + [22, 23, 35, 22, 22, 22, 22, 28, 38, 38, 18, 34] + [45, 11, 68, 68, 68, 68, 68, 45], "freeze": (1, 2), "hidden_columns": list(range(22, 30))},
        {"name": "原文与出处", "headers": ["片段ID", "归属样本/风险/Figure", "版本臂", "片段角色", "原片段序号", "同一片段部分序号", "论文", "物理页〔点击PDF〕", "机器来源类型〔未人核〕", "原文〔逐字；独立片段〕", "原文block_id", "start码点", "end码点", "原PDF框〔pt〕", "定位精度", "原结构引用", "文本版本", "PDF SHA-256"],
         "rows": source_rows, "widths": [18, 27, 14, 20, 13, 18, 10, 16, 28, 108, 49, 14, 14, 60, 35, 45, 45, 68], "freeze": (1, 2)},
        {"name": "5条实验风险", "headers": risk_headers, "rows": risk_rows,
         "widths": [23, 38, 43, 11, 65, 70, 70, 30, 23, 68, 68, 23] + [22, 23, 35, 22, 22, 22, 22, 28, 38, 38, 18, 34] + [46, 68, 68, 68, 45], "freeze": (1, 2), "hidden_columns": [9, 10] + list(range(24, 29))},
    ]


def write_workbook(sheets, output):
    with xlsxwriter.Workbook(str(output), {"strings_to_formulas": False, "strings_to_urls": False}) as book:
        book.set_properties({"title": "三方法真实输出人工核验", "subject": "随机baseline与定向实验风险分别核验", "author": "T1离线导出工具；非人工审核者"})
        formats = {
            "head": book.add_format({"bold": True, "bg_color": "#0F3D56", "font_color": "#FFFFFF", "text_wrap": True, "valign": "vcenter", "border": 1}),
            "fixed": book.add_format({"text_wrap": True, "valign": "top", "font_name": "Aptos", "font_size": 11, "locked": True}),
            "manual": book.add_format({"text_wrap": True, "valign": "top", "bg_color": "#FFF2CC", "locked": False}),
            "link": book.add_format({"text_wrap": True, "valign": "top", "font_color": "#0563C1", "underline": 1, "locked": True}),
        }
        for spec in sheets:
            sheet = book.add_worksheet(spec["name"])
            sheet.freeze_panes(*spec.get("freeze", (1, 0)))
            sheet.set_row(0, 45)
            for col, name in enumerate(spec["headers"]):
                sheet.write_string(0, col, name, formats["head"])
                sheet.set_column(col, col, spec["widths"][col], None, {"hidden": col in spec.get("hidden_columns", [])})
            for rowno, row in enumerate(spec["rows"], 1):
                if len(row) != len(spec["headers"]):
                    raise ValueError("workbook_column_count_mismatch")
                sheet.set_row(rowno, 95 if spec["name"] == "说明" else 105)
                for col, value in enumerate(row):
                    if len(value["v"].encode("utf-16-le")) // 2 > 32767:
                        raise ValueError("workbook_cell_overflow_refused_not_truncated")
                    if value.get("manual"):
                        sheet.write_blank(rowno, col, None, formats["manual"])
                        if value.get("options"):
                            sheet.data_validation(rowno, col, rowno, col, {"validate": "list", "source": value["options"], "ignore_blank": True, "error_type": "stop", "error_title": "请选择人工判断", "error_message": "尚未核验请保持空白。"})
                    elif value.get("link"):
                        if sheet.write_url(rowno, col, value["link"], formats["link"], string=value["v"]) != 0:
                            raise ValueError("workbook_link_write_failed")
                    else:
                        if sheet.write_string(rowno, col, value["v"], formats["fixed"]) != 0:
                            raise ValueError("workbook_literal_write_failed")
                    if value.get("comment"):
                        sheet.write_comment(rowno, col, value["comment"], {"author": "源字符提示（非人审）"})
            sheet.autofilter(0, 0, len(spec["rows"]), len(spec["headers"]) - 1)
            sheet.protect("", {"autofilter": True, "sort": True, "select_locked_cells": True, "select_unlocked_cells": True})
            sheet.set_zoom(85)
            sheet.set_landscape()
            sheet.fit_to_pages(1, 0)
            sheet.repeat_rows(0)


def valid_time(value):
    if not re.search(r"(?:Z|[+-]\d{2}:\d{2})$", value):
        return False
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).tzinfo is not None
    except ValueError:
        return False


def inspect_workbook(sheets, path):
    raw_strings = raw_string_cells(path)
    if hasattr(path, "seek"):
        path.seek(0)
    book = openpyxl.load_workbook(path, data_only=False)
    if book.sheetnames != [s["name"] for s in sheets]:
        raise ValueError("review_workbook_sheets_changed")
    report = {"schema_version": "offline-output-review-readback-1", "random_rows": 0, "risk_rows": 0,
              "random_signed_complete_rows": 0, "risk_signed_complete_rows": 0, "incomplete_rows": [],
              "manual_nonempty_cells": 0, "formula_cells": 0, "source_literal_cells": 0,
              "manual_total_cells": 0, "immutable_hyperlinks_checked": 0,
              "ooxml_decoded_control_cells": 0, "ooxml_control_diagnostics": [],
              "product_export_approved": False, "medical_quality_approved": False,
              "application_review_events_written": 0, "database_writes": 0,
              "signature_authority": "user_supplied_workbook_fields_only_not_identity_authentication",
              "stage_passed": False, "accuracy": None, "recall": None}
    for spec in sheets:
        sheet = book[spec["name"]]
        if sheet.max_row != len(spec["rows"]) + 1 or sheet.max_column != len(spec["headers"]):
            raise ValueError("review_workbook_shape_changed")
        expected = [[cell(v) for v in spec["headers"]]] + spec["rows"]
        for rowno, values in enumerate(expected, 1):
            manual = {}
            for colno, want in enumerate(values, 1):
                actual = sheet.cell(rowno, colno)
                if actual.data_type == "f":
                    raise ValueError("review_workbook_formula_refused")
                reader_value = actual.value if actual.value is not None else ""
                raw = raw_strings.get((spec["name"], actual.coordinate))
                value = raw["decoded"] if raw else reader_value
                if want.get("manual"):
                    report["manual_total_cells"] += 1
                    if not isinstance(value, str):
                        raise ValueError("review_workbook_manual_literal_required")
                    key = want["manual"]
                    manual[key] = value.strip()
                    if value:
                        report["manual_nonempty_cells"] += 1
                    if value and want.get("options") and value not in want["options"]:
                        raise ValueError("review_workbook_judgment_invalid")
                else:
                    if value != want["v"]:
                        raise ValueError(f"review_workbook_bound_content_changed:{spec['name']}!{actual.coordinate}")
                    if want.get("link"):
                        link = actual.hyperlink
                        expected_link = want["link"]
                        if expected_link.startswith("internal:"):
                            equal_link = link and not link.target and link.location == expected_link.removeprefix("internal:")
                        else:
                            target = (link.target or "").replace("\\", "/") if link else ""
                            actual_link = target + ("#" + link.location if link and link.location else "")
                            equal_link = actual_link == expected_link.removeprefix("external:")
                        if not equal_link:
                            raise ValueError("review_workbook_bound_hyperlink_changed")
                        report["immutable_hyperlinks_checked"] += 1
                    if spec["name"] == "原文与出处" and colno == 10 and rowno > 1:
                        report["source_literal_cells"] += 1
                        if control_characters(value):
                            report["ooxml_decoded_control_cells"] += 1
                            report["ooxml_control_diagnostics"].append({"cell": f"{spec['name']}!{actual.coordinate}", "fragment_id": values[0]["v"],
                                "owner_id": values[1]["v"], "original_code_point_length": len(value), "openpyxl_value_length": len(reader_value),
                                "source_control_codepoints": control_characters(value), "ooxml_text_excerpt": raw["raw"][:180] if raw else "",
                                "exact_equality_after_single_pass_ooxml_decode": True})
            if manual:
                is_risk = "risk_assessment" in manual
                prefix = "risk" if is_risk else "random"
                report[prefix + "_rows"] += 1
                if any(manual.values()):
                    missing = [k for k in CHECKS + ["reviewer", "reviewed_at"] if not manual.get(k)]
                    if is_risk and not manual.get("risk_assessment"):
                        missing.append("risk_assessment")
                    if manual.get("reviewed_at") and not valid_time(manual["reviewed_at"]):
                        missing.append("reviewed_at_timezone_or_format_invalid")
                    if missing:
                        report["incomplete_rows"].append({"row_id": values[0]["v"], "missing": missing})
                    else:
                        report[prefix + "_signed_complete_rows"] += 1
    report["random_unreviewed_or_incomplete_rows"] = report["random_rows"] - report["random_signed_complete_rows"]
    report["risk_unreviewed_or_incomplete_rows"] = report["risk_rows"] - report["risk_signed_complete_rows"]
    report["all_manual_fields_blank"] = report["manual_nonempty_cells"] == 0
    book.close()
    return report


def verify_zip(zip_path, workbook_path=None):
    with ZipFile(zip_path) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)) or any(Path(n).is_absolute() or ".." in Path(n).parts or "\\" in n for n in names):
            raise ValueError("review_pack_zip_path_invalid")
        pack = json.loads(archive.read("pack-manifest.json"))
        hashes = pack["artifacts"]
        if set(names) != set(hashes) | {"pack-manifest.json"}:
            raise ValueError("review_pack_zip_inventory_changed")
        for name, expected in hashes.items():
            if hashlib.sha256(archive.read(name)).hexdigest() != expected:
                raise ValueError("review_pack_zip_artifact_sha_mismatch")
        import io
        source = workbook_path or io.BytesIO(archive.read("核验表.xlsx"))
        report = inspect_workbook(build_sheets(pack), source)
        report["archive_artifact_hashes_verified"] = len(hashes)
        report["pack_id"] = pack["pack_id"]
        return report


def main():
    args = sys.argv[1:]
    if len(args) == 3 and args[0] == "render":
        pack = json.loads(Path(args[1]).read_text())
        if Path(args[2]).exists():
            raise ValueError("review_workbook_output_exists")
        write_workbook(build_sheets(pack), Path(args[2]))
        print(json.dumps(inspect_workbook(build_sheets(pack), args[2]), ensure_ascii=False))
    elif len(args) in (2, 3) and args[0] == "inspect":
        print(json.dumps(verify_zip(args[1], args[2] if len(args) == 3 else None), ensure_ascii=False))
    else:
        raise ValueError("usage: output-review-workbook.py render PACK_JSON NEW_XLSX | inspect PACK_ZIP [RETURNED_XLSX]")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, TypeError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
