export const WORKBOOK_PYTHON_SCRIPT = String.raw`#!/usr/bin/env python3
"""Bounded OOXML workbook inspection, decimal audit, and surgical column edit."""

from __future__ import annotations

import base64
import copy
import hashlib
import html
import io
import json
import posixpath
import re
import sys
import zipfile
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP, localcontext
from xml.etree import ElementTree as ET

MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
DOC_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
NS = {"x": MAIN_NS, "r": DOC_REL_NS}
Q = lambda name: f"{{{MAIN_NS}}}{name}"
CELL_RE = re.compile(r"^\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6})$")
RANGE_RE = re.compile(r"^\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6}):\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6})$")
FORMULA_TOKEN_RE = re.compile(
    r"\s*(?:(\d+(?:\.\d*)?|\.\d+)|(\$?[A-Za-z]{1,3}\$?[1-9][0-9]{0,6})|([A-Za-z_][A-Za-z0-9_.]*)|([()+\-*/, :]))"
)
MAX_ZIP_ENTRIES = 4096
MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024
MAX_RANGE_CELLS = 20_000
MAX_FORMULA_DEPTH = 32

ET.register_namespace("", MAIN_NS)
ET.register_namespace("r", DOC_REL_NS)


class WorkbookError(Exception):
    def __init__(self, code: str, message: str = "") -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def require(condition: bool, code: str, message: str = "") -> None:
    if not condition:
        raise WorkbookError(code, message)


def column_number(label: str) -> int:
    value = 0
    for char in label.upper():
        require("A" <= char <= "Z", "CELL_REFERENCE_INVALID", label)
        value = value * 26 + ord(char) - 64
    require(1 <= value <= 16384, "COLUMN_OUT_OF_RANGE", label)
    return value


def column_label(number: int) -> str:
    require(1 <= number <= 16384, "COLUMN_OUT_OF_RANGE", str(number))
    result = ""
    while number:
        number, remainder = divmod(number - 1, 26)
        result = chr(65 + remainder) + result
    return result


def parse_cell(reference: str) -> tuple[int, int]:
    match = CELL_RE.fullmatch(reference)
    require(bool(match), "CELL_REFERENCE_INVALID", reference)
    assert match
    return column_number(match.group(1)), int(match.group(2))


def cell_reference(column: int, row: int) -> str:
    return f"{column_label(column)}{row}"


def parse_range(reference: str) -> tuple[int, int, int, int]:
    single = CELL_RE.fullmatch(reference)
    if single:
        column, row = parse_cell(reference)
        return column, row, column, row
    match = RANGE_RE.fullmatch(reference)
    require(bool(match), "RANGE_REFERENCE_INVALID", reference)
    assert match
    first_column = column_number(match.group(1))
    first_row = int(match.group(2))
    last_column = column_number(match.group(3))
    last_row = int(match.group(4))
    require(first_column <= last_column and first_row <= last_row, "RANGE_REFERENCE_REVERSED", reference)
    require((last_column - first_column + 1) * (last_row - first_row + 1) <= MAX_RANGE_CELLS, "RANGE_TOO_LARGE", reference)
    return first_column, first_row, last_column, last_row


def decimal_text(value: Decimal) -> str:
    if value == 0:
        return "0"
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def money_text(value: Decimal) -> str:
    return format(value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP), ".2f")


class WorkbookPackage:
    def __init__(self, content: bytes) -> None:
        try:
            self.archive = zipfile.ZipFile(io.BytesIO(content), "r")
        except (zipfile.BadZipFile, ValueError) as error:
            raise WorkbookError("WORKBOOK_ZIP_INVALID", str(error)) from error
        infos = self.archive.infolist()
        require(0 < len(infos) <= MAX_ZIP_ENTRIES, "WORKBOOK_ZIP_ENTRY_LIMIT")
        require(sum(info.file_size for info in infos) <= MAX_UNCOMPRESSED_BYTES, "WORKBOOK_UNCOMPRESSED_LIMIT")
        for info in infos:
            normalized = posixpath.normpath(info.filename)
            require(not info.flag_bits & 0x1, "WORKBOOK_ENCRYPTED_UNSUPPORTED")
            require(not normalized.startswith("../") and not normalized.startswith("/"), "WORKBOOK_ZIP_PATH_UNSAFE")
        self.parts = {info.filename: self.archive.read(info.filename) for info in infos}
        self.infos = infos
        require("xl/workbook.xml" in self.parts and "xl/_rels/workbook.xml.rels" in self.parts, "WORKBOOK_PARTS_MISSING")
        self.workbook_root = self.xml("xl/workbook.xml")
        relationships = self.xml("xl/_rels/workbook.xml.rels")
        relationship_targets = {
            item.attrib["Id"]: item.attrib["Target"]
            for item in relationships.findall(f"{{{PKG_REL_NS}}}Relationship")
            if "Id" in item.attrib and "Target" in item.attrib
        }
        self.sheets: list[dict[str, object]] = []
        for index, sheet in enumerate(self.workbook_root.findall("x:sheets/x:sheet", NS)):
            relationship_id = sheet.attrib.get(f"{{{DOC_REL_NS}}}id", "")
            target = relationship_targets.get(relationship_id)
            require(bool(target), "WORKSHEET_RELATIONSHIP_MISSING", sheet.attrib.get("name", ""))
            path = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join("xl", target))
            require(path in self.parts, "WORKSHEET_PART_MISSING", path)
            self.sheets.append(
                {
                    "name": sheet.attrib.get("name", ""),
                    "state": sheet.attrib.get("state", "visible"),
                    "path": path,
                    "index": index,
                }
            )
        self.shared_strings = self._shared_strings()

    def xml(self, path: str) -> ET.Element:
        try:
            for _, namespace in ET.iterparse(io.BytesIO(self.parts[path]), events=("start-ns",)):
                prefix, uri = namespace
                if prefix != "xml":
                    try:
                        ET.register_namespace(prefix, uri)
                    except ValueError:
                        pass
            return ET.fromstring(self.parts[path])
        except (ET.ParseError, KeyError) as error:
            raise WorkbookError("WORKBOOK_XML_INVALID", path) from error

    def _shared_strings(self) -> list[str]:
        if "xl/sharedStrings.xml" not in self.parts:
            return []
        root = self.xml("xl/sharedStrings.xml")
        return ["".join(node.text or "" for node in item.iter(Q("t"))) for item in root.findall("x:si", NS)]

    def sheet(self, name: str) -> dict[str, object]:
        require(isinstance(name, str) and bool(name), "SHEET_REQUIRED")
        for sheet in self.sheets:
            if sheet["name"] == name:
                return sheet
        raise WorkbookError("SHEET_NOT_FOUND", name)

    def print_area(self, sheet_index: int) -> str | None:
        for defined in self.workbook_root.findall("x:definedNames/x:definedName", NS):
            if defined.attrib.get("name") == "_xlnm.Print_Area" and defined.attrib.get("localSheetId") == str(sheet_index):
                return defined.text
        return None

    def write_with_parts(self, updates: dict[str, bytes]) -> bytes:
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as target:
            for info in self.infos:
                cloned = copy.copy(info)
                target.writestr(cloned, updates.get(info.filename, self.parts[info.filename]))
        return output.getvalue()


def serialize_xml(root: ET.Element, original: bytes) -> bytes:
    namespaces: list[tuple[str, str]] = []
    for _, namespace in ET.iterparse(io.BytesIO(original), events=("start-ns",)):
        if namespace not in namespaces:
            namespaces.append(namespace)
    serialized = ET.tostring(root, encoding="utf-8", xml_declaration=True)
    declaration_end = serialized.find(b"?>")
    root_start = serialized.find(b"<", declaration_end + 2 if declaration_end >= 0 else 0)
    root_end = serialized.find(b">", root_start)
    require(root_start >= 0 and root_end >= 0, "WORKBOOK_XML_SERIALIZE_FAILED")
    start_tag = serialized[root_start:root_end]
    additions = []
    for prefix, uri in namespaces:
        marker = (f"xmlns:{prefix}=" if prefix else "xmlns=").encode("utf-8")
        if marker not in start_tag:
            name = f"xmlns:{prefix}" if prefix else "xmlns"
            additions.append(f" {name}=\"{html.escape(uri, quote=True)}\"".encode("utf-8"))
    if additions:
        serialized = serialized[:root_end] + b"".join(additions) + serialized[root_end:]
    return serialized


def cell_map(root: ET.Element) -> dict[str, ET.Element]:
    return {
        cell.attrib["r"].replace("$", "").upper(): cell
        for cell in root.findall("x:sheetData/x:row/x:c", NS)
        if "r" in cell.attrib
    }


def inline_text(cell: ET.Element) -> str:
    return "".join(node.text or "" for node in cell.findall("x:is//x:t", NS))


def read_cell(cell: ET.Element | None, shared_strings: list[str]) -> dict[str, object]:
    if cell is None:
        return {"kind": "blank", "value": None}
    formula = cell.find("x:f", NS)
    if formula is not None:
        return {"kind": "formula", "formula": formula.text or ""}
    cell_type = cell.attrib.get("t")
    value = cell.findtext("x:v", default="", namespaces=NS)
    if cell_type == "s":
        try:
            return {"kind": "text", "value": shared_strings[int(value)]}
        except (ValueError, IndexError) as error:
            raise WorkbookError("SHARED_STRING_INVALID", cell.attrib.get("r", "")) from error
    if cell_type == "inlineStr":
        return {"kind": "text", "value": inline_text(cell)}
    if cell_type == "b":
        return {"kind": "boolean", "value": value == "1"}
    if cell_type in ("str", "e"):
        return {"kind": "text" if cell_type == "str" else "error", "value": value}
    if not value:
        return {"kind": "blank", "value": None}
    try:
        numeric = Decimal(value)
    except InvalidOperation as error:
        raise WorkbookError("NUMERIC_CELL_INVALID", cell.attrib.get("r", "")) from error
    require(numeric.is_finite(), "NUMERIC_CELL_INVALID", cell.attrib.get("r", ""))
    return {"kind": "number", "value": value}


def merge_references(root: ET.Element) -> list[str]:
    return [merge.attrib["ref"] for merge in root.findall("x:mergeCells/x:mergeCell", NS) if "ref" in merge.attrib]


def inspect(content: bytes, args: dict[str, object]) -> dict[str, object]:
    package = WorkbookPackage(content)
    max_rows = args.get("maxRows", 50)
    max_columns = args.get("maxColumns", 40)
    require(isinstance(max_rows, int) and 1 <= max_rows <= 200, "INSPECT_MAX_ROWS_INVALID")
    require(isinstance(max_columns, int) and 1 <= max_columns <= 100, "INSPECT_MAX_COLUMNS_INVALID")
    requested_sheet = args.get("sheet")
    require(requested_sheet is None or isinstance(requested_sheet, str), "SHEET_INVALID")
    selected = [package.sheet(requested_sheet)] if requested_sheet else package.sheets
    result_sheets = []
    for sheet in selected:
        root = package.xml(str(sheet["path"]))
        dimension = root.find("x:dimension", NS)
        cells = cell_map(root)
        rows: list[dict[str, object]] = []
        header_candidates: list[dict[str, object]] = []
        formulas: list[dict[str, str]] = []
        for row_number in range(1, (max_rows if requested_sheet or sheet["state"] == "visible" else 0) + 1):
            values: list[dict[str, object]] = []
            text_count = 0
            for column in range(1, max_columns + 1):
                reference = cell_reference(column, row_number)
                cell = cells.get(reference)
                if cell is None:
                    continue
                value = read_cell(cell, package.shared_strings)
                if value["kind"] == "formula":
                    formulas.append({"cell": reference, "formula": str(value["formula"])})
                if value.get("value") not in (None, "") or value["kind"] == "formula":
                    values.append({"cell": reference, **value})
                    if value["kind"] == "text" and value.get("value"):
                        text_count += 1
            if values:
                rows.append({"row": row_number, "cells": values})
                if text_count >= 2:
                    header_candidates.append({"row": row_number, "textCellCount": text_count})
        result_sheets.append(
            {
                "name": sheet["name"],
                "state": sheet["state"],
                "dimension": dimension.attrib.get("ref") if dimension is not None else None,
                "headerCandidates": header_candidates,
                "merges": merge_references(root),
                "printArea": package.print_area(int(sheet["index"])),
                "formulas": formulas,
                "auditSuggestions": [
                    {"sheet": sheet["name"], "amountRange": match.group(1).replace("$", "").upper(), "totalCell": reference,
                     "note": "Single-column subtotal candidate; verify this matches the requested business amount. Do not add this total to its own details."}
                    for reference, cell in cells.items()
                    if (formula := cell.find("x:f", NS)) is not None and (match := re.fullmatch(r"SUM\((\$?[A-Z]{1,3}\$?[1-9][0-9]*:\$?[A-Z]{1,3}\$?[1-9][0-9]*)\)", (formula.text or "").upper()))
                    and parse_range(match.group(1))[0] == parse_range(match.group(1))[2] == parse_cell(reference)[0]
                    and parse_cell(reference)[1] > parse_range(match.group(1))[3]
                ][:8] if sheet["state"] == "visible" else [],
                "hiddenDataOmitted": not requested_sheet and sheet["state"] != "visible",
                "rows": rows,
                "boundedAt": {"maxRows": max_rows, "maxColumns": max_columns},
            }
        )
    return {"sheets": result_sheets, "sheetCount": len(package.sheets)}


class FormulaParser:
    def __init__(self, formula: str, resolve_cell, resolve_range) -> None:
        self.formula = formula[1:] if formula.startswith("=") else formula
        self.resolve_cell = resolve_cell
        self.resolve_range = resolve_range
        self.tokens = self._tokens(self.formula)
        self.position = 0

    @staticmethod
    def _tokens(formula: str) -> list[tuple[str, str]]:
        tokens: list[tuple[str, str]] = []
        position = 0
        while position < len(formula):
            match = FORMULA_TOKEN_RE.match(formula, position)
            if not match:
                raise WorkbookError("FORMULA_UNSUPPORTED", formula)
            number, cell, name, punctuation = match.groups()
            if number:
                tokens.append(("number", number))
            elif cell:
                tokens.append(("cell", cell.replace("$", "").upper()))
            elif name:
                tokens.append(("name", name.upper()))
            elif punctuation and not punctuation.isspace():
                tokens.append((punctuation, punctuation))
            position = match.end()
        return tokens

    def peek(self, token_type: str | None = None) -> tuple[str, str] | None:
        if self.position >= len(self.tokens):
            return None
        token = self.tokens[self.position]
        return token if token_type is None or token[0] == token_type else None

    def take(self, token_type: str) -> tuple[str, str]:
        token = self.peek(token_type)
        if token is None:
            raise WorkbookError("FORMULA_UNSUPPORTED", self.formula)
        self.position += 1
        return token

    def parse(self) -> Decimal:
        value = self.expression()
        require(self.position == len(self.tokens), "FORMULA_UNSUPPORTED", self.formula)
        return value

    def expression(self) -> Decimal:
        value = self.term()
        while self.peek("+") or self.peek("-"):
            operator = self.take(self.peek()[0])[0]  # type: ignore[index]
            right = self.term()
            value = value + right if operator == "+" else value - right
        return value

    def term(self) -> Decimal:
        value = self.factor()
        while self.peek("*") or self.peek("/"):
            operator = self.take(self.peek()[0])[0]  # type: ignore[index]
            right = self.factor()
            if operator == "/" and right == 0:
                raise WorkbookError("FORMULA_DIVISION_BY_ZERO", self.formula)
            value = value * right if operator == "*" else value / right
        return value

    def factor(self) -> Decimal:
        if self.peek("+"):
            self.take("+")
            return self.factor()
        if self.peek("-"):
            self.take("-")
            return -self.factor()
        if self.peek("number"):
            return Decimal(self.take("number")[1])
        if self.peek("cell"):
            first = self.take("cell")[1]
            if self.peek(":"):
                raise WorkbookError("FORMULA_RANGE_REQUIRES_SUM", self.formula)
            return self.resolve_cell(first)
        if self.peek("("):
            self.take("(")
            value = self.expression()
            self.take(")")
            return value
        if self.peek("name"):
            name = self.take("name")[1]
            require(name == "SUM", "FORMULA_UNSUPPORTED", self.formula)
            self.take("(")
            total = Decimal(0)
            has_value = False
            while not self.peek(")"):
                if self.peek("cell"):
                    first = self.take("cell")[1]
                    if self.peek(":"):
                        self.take(":")
                        last = self.take("cell")[1]
                        total += sum(self.resolve_range(first, last), Decimal(0))
                    else:
                        total += self.resolve_cell(first)
                else:
                    total += self.expression()
                has_value = True
                if not self.peek(","):
                    break
                self.take(",")
            self.take(")")
            require(has_value, "FORMULA_UNSUPPORTED", self.formula)
            return total
        raise WorkbookError("FORMULA_UNSUPPORTED", self.formula)


class DecimalEvaluator:
    def __init__(self, root: ET.Element, shared_strings: list[str]) -> None:
        self.cells = cell_map(root)
        self.shared_strings = shared_strings
        self.cache: dict[str, Decimal] = {}
        self.stack: list[str] = []
        self.dependencies: dict[str, set[str]] = {}

    def cell(self, reference: str) -> Decimal:
        reference = reference.replace("$", "").upper()
        if self.stack:
            self.dependencies.setdefault(self.stack[-1], set()).add(reference)
        if reference in self.cache:
            return self.cache[reference]
        require(len(self.stack) < MAX_FORMULA_DEPTH and reference not in self.stack, "FORMULA_CIRCULAR_OR_TOO_DEEP", reference)
        value = read_cell(self.cells.get(reference), self.shared_strings)
        if value["kind"] == "blank":
            result = Decimal(0)
        elif value["kind"] == "number":
            result = Decimal(str(value["value"]))
        elif value["kind"] == "formula":
            self.stack.append(reference)
            try:
                result = FormulaParser(str(value["formula"]), self.cell, self.range).parse()
            finally:
                self.stack.pop()
        else:
            raise WorkbookError("FORMULA_NON_NUMERIC_REFERENCE", reference)
        self.cache[reference] = result
        return result

    def range(self, first: str, last: str) -> list[Decimal]:
        first_column, first_row = parse_cell(first)
        last_column, last_row = parse_cell(last)
        require(first_column <= last_column and first_row <= last_row, "FORMULA_RANGE_REVERSED")
        require((last_column - first_column + 1) * (last_row - first_row + 1) <= MAX_RANGE_CELLS, "FORMULA_RANGE_TOO_LARGE")
        return [
            self.cell(cell_reference(column, row))
            for row in range(first_row, last_row + 1)
            for column in range(first_column, last_column + 1)
        ]


def audit(content: bytes, args: dict[str, object]) -> dict[str, object]:
    package = WorkbookPackage(content)
    sheet = package.sheet(args.get("sheet") if isinstance(args.get("sheet"), str) else "")
    ranges: list[str] = []
    if "amountRange" in args:
        require(isinstance(args["amountRange"], str), "AMOUNT_RANGE_INVALID")
        ranges.append(str(args["amountRange"]))
    if "amountRanges" in args:
        require(isinstance(args["amountRanges"], list), "AMOUNT_RANGES_INVALID")
        require(all(isinstance(item, str) for item in args["amountRanges"]), "AMOUNT_RANGES_INVALID")
        ranges.extend(args["amountRanges"])  # type: ignore[arg-type]
    require(1 <= len(ranges) <= 32, "AMOUNT_RANGE_REQUIRED")
    require(len(set(ranges)) == len(ranges), "AMOUNT_RANGE_DUPLICATE")
    currency = args.get("currency", "CNY")
    require(isinstance(currency, str) and bool(re.fullmatch(r"[A-Z]{3}", currency)), "CURRENCY_INVALID")
    root = package.xml(str(sheet["path"]))
    evaluator = DecimalEvaluator(root, package.shared_strings)
    cells = evaluator.cells
    details: list[dict[str, object]] = []
    total = Decimal(0)
    seen: set[str] = set()
    with localcontext() as context:
        context.prec = 50
        for amount_range in ranges:
            first_column, first_row, last_column, last_row = parse_range(amount_range)
            for row in range(first_row, last_row + 1):
                for column in range(first_column, last_column + 1):
                    reference = cell_reference(column, row)
                    require(reference not in seen, "AMOUNT_RANGE_OVERLAP", reference)
                    seen.add(reference)
                    raw = read_cell(cells.get(reference), package.shared_strings)
                    if raw["kind"] == "blank":
                        continue
                    require(raw["kind"] in ("number", "formula"), "AUDIT_NON_NUMERIC_CELL", reference)
                    value = evaluator.cell(reference)
                    total += value
                    details.append(
                        {
                            "cell": reference,
                            "value": decimal_text(value),
                            "source": "formula-evaluated" if raw["kind"] == "formula" else "xml",
                            **({"formula": raw["formula"]} if raw["kind"] == "formula" else {}),
                        }
                    )
        def selected_dependency(reference, visited):
            for child in evaluator.dependencies.get(reference, set()):
                if child in seen: return child
                if child not in visited:
                    visited.add(child)
                    nested = selected_dependency(child, visited)
                    if nested: return nested
            return None
        for reference in seen:
            duplicate = selected_dependency(reference, set())
            require(not duplicate, "AMOUNT_DEPENDENCY_OVERLAP", str(reference)+" includes selected "+str(duplicate)+"; choose detail cells OR their formula totals, not both")
        expected = args.get("expectedTotal")
        expected_decimal: Decimal | None = None
        if "expectedTotal" in args:
            require(isinstance(expected, (str, int, float)) and not isinstance(expected, bool), "EXPECTED_TOTAL_INVALID")
            try:
                expected_decimal = Decimal(str(expected))
            except InvalidOperation as error:
                raise WorkbookError("EXPECTED_TOTAL_INVALID") from error
            require(expected_decimal.is_finite(), "EXPECTED_TOTAL_INVALID")
        total_cell = args.get("totalCell")
        require(total_cell is None or isinstance(total_cell, str) and bool(CELL_RE.fullmatch(total_cell)), "TOTAL_CELL_INVALID")
        workbook_total = None
        if isinstance(total_cell, str):
            total_cell = total_cell.replace("$", "").upper()
            total_raw = read_cell(cells.get(total_cell), package.shared_strings)
            require(total_raw["kind"] in ("number", "formula"), "TOTAL_CELL_VALUE_INVALID", total_cell)
            workbook_total = evaluator.cell(total_cell)
        return {
            "status": "mismatch" if (expected_decimal is not None and money_text(total) != money_text(expected_decimal)) or (workbook_total is not None and money_text(total) != money_text(workbook_total)) else "matched" if workbook_total is not None or expected_decimal is not None else "calculated_only",
            "sheet": sheet["name"],
            "amountRanges": ranges,
            "currency": currency,
            "rounding": "ROUND_HALF_UP",
            "scale": 2,
            "detailCount": len(details),
            "values": details,
            "exactTotal": decimal_text(total),
            "total": money_text(total),
            "expectedTotal": money_text(expected_decimal) if expected_decimal is not None else None,
            "difference": money_text(total - expected_decimal) if expected_decimal is not None else None,
            "totalCell": total_cell,
            "workbookTotal": money_text(workbook_total) if workbook_total is not None else None,
            "workbookDifference": money_text(total - workbook_total) if workbook_total is not None else None,
        }


def find_row(sheet_data: ET.Element, row_number: int, create: bool) -> ET.Element | None:
    for row in sheet_data.findall("x:row", NS):
        if int(row.attrib.get("r", "0")) == row_number:
            return row
    if not create:
        return None
    row = ET.Element(Q("row"), {"r": str(row_number)})
    inserted = False
    for index, existing in enumerate(list(sheet_data)):
        if int(existing.attrib.get("r", "0")) > row_number:
            sheet_data.insert(index, row)
            inserted = True
            break
    if not inserted:
        sheet_data.append(row)
    return row


def find_cell_in_row(row: ET.Element | None, reference: str) -> ET.Element | None:
    if row is None:
        return None
    for cell in row.findall("x:c", NS):
        if cell.attrib.get("r", "").replace("$", "").upper() == reference:
            return cell
    return None


def remove_cell(root: ET.Element, column: int, row_number: int) -> None:
    sheet_data = root.find("x:sheetData", NS)
    assert sheet_data is not None
    row = find_row(sheet_data, row_number, False)
    cell = find_cell_in_row(row, cell_reference(column, row_number))
    if row is not None and cell is not None:
        row.remove(cell)
        if not row.findall("x:c", NS) and len(row) == 0:
            sheet_data.remove(row)


def style_for(root: ET.Element, column: int, row_number: int) -> str | None:
    cells = cell_map(root)
    target = cells.get(cell_reference(column, row_number))
    if target is not None and "s" in target.attrib:
        return target.attrib["s"]
    if column > 1:
        neighbor = cells.get(cell_reference(column - 1, row_number))
        if neighbor is not None and "s" in neighbor.attrib:
            return neighbor.attrib["s"]
    return None


def set_cell(root: ET.Element, column: int, row_number: int, value: object, style: str | None = None) -> None:
    if value is None:
        remove_cell(root, column, row_number)
        return
    sheet_data = root.find("x:sheetData", NS)
    assert sheet_data is not None
    row = find_row(sheet_data, row_number, True)
    assert row is not None
    reference = cell_reference(column, row_number)
    cell = find_cell_in_row(row, reference)
    if cell is None:
        cell = ET.Element(Q("c"), {"r": reference})
        inserted = False
        for index, existing in enumerate(row.findall("x:c", NS)):
            existing_column, _ = parse_cell(existing.attrib["r"])
            if existing_column > column:
                row.insert(index, cell)
                inserted = True
                break
        if not inserted:
            row.append(cell)
    else:
        require(cell.find("x:f", NS) is None, "EDIT_FORMULA_OVERWRITE_UNSAFE", reference)
        for child in list(cell):
            cell.remove(child)
    if style is not None:
        cell.attrib["s"] = style
    if isinstance(value, bool):
        cell.attrib["t"] = "b"
        ET.SubElement(cell, Q("v")).text = "1" if value else "0"
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        require(str(value) not in ("nan", "inf", "-inf"), "EDIT_VALUE_INVALID", reference)
        cell.attrib.pop("t", None)
        ET.SubElement(cell, Q("v")).text = str(value)
    else:
        require(isinstance(value, str), "EDIT_VALUE_INVALID", reference)
        cell.attrib["t"] = "inlineStr"
        inline = ET.SubElement(cell, Q("is"))
        text = ET.SubElement(inline, Q("t"))
        if value[:1].isspace() or value[-1:].isspace():
            text.attrib["{http://www.w3.org/XML/1998/namespace}space"] = "preserve"
        text.text = value


def merged_range_contains(reference: str, column: int, row: int) -> bool:
    first_column, first_row, last_column, last_row = parse_range(reference)
    return first_column <= column <= last_column and first_row <= row <= last_row


def extend_title_merge(root: ET.Element, target_column: int) -> dict[str, str] | None:
    merge_cells = root.find("x:mergeCells", NS)
    if merge_cells is None:
        return None
    title_merge: ET.Element | None = None
    bounds: tuple[int, int, int, int] | None = None
    for merge in merge_cells.findall("x:mergeCell", NS):
        reference = merge.attrib.get("ref", "")
        parsed = parse_range(reference)
        if parsed[0] == 1 and parsed[1] == 1 and parsed[3] == 1:
            require(title_merge is None, "TITLE_MERGE_AMBIGUOUS")
            title_merge, bounds = merge, parsed
    if title_merge is None or bounds is None or target_column <= bounds[2]:
        return None
    require(target_column == bounds[2] + 1, "TITLE_MERGE_EXTENSION_GAP")
    for merge in merge_cells.findall("x:mergeCell", NS):
        if merge is title_merge:
            continue
        first_column, first_row, last_column, last_row = parse_range(merge.attrib["ref"])
        if first_column <= target_column <= last_column and first_row <= 1 <= last_row:
            raise WorkbookError("TITLE_MERGE_EXTENSION_COLLISION", merge.attrib["ref"])
    previous = title_merge.attrib["ref"]
    updated = f"A1:{column_label(target_column)}1"
    title_merge.attrib["ref"] = updated
    return {"from": previous, "to": updated}


def update_dimension(root: ET.Element, target_column: int, end_row: int) -> None:
    dimension = root.find("x:dimension", NS)
    if dimension is None:
        root.insert(0, ET.Element(Q("dimension"), {"ref": f"A1:{cell_reference(target_column, end_row)}"}))
        return
    reference = dimension.attrib.get("ref", "A1")
    try:
        first_column, first_row, last_column, last_row = parse_range(reference)
    except WorkbookError:
        first_column, first_row, last_column, last_row = 1, 1, target_column, end_row
    dimension.attrib["ref"] = (
        cell_reference(min(first_column, target_column), min(first_row, 1))
        + ":"
        + cell_reference(max(last_column, target_column), max(last_row, end_row))
    )


def copy_column_definition(root: ET.Element, target_column: int) -> None:
    columns = root.find("x:cols", NS)
    if columns is None:
        return
    definitions = columns.findall("x:col", NS)
    if any(int(item.attrib["min"]) <= target_column <= int(item.attrib["max"]) for item in definitions):
        return
    source = next(
        (item for item in definitions if int(item.attrib["min"]) <= target_column - 1 <= int(item.attrib["max"])),
        None,
    )
    if source is not None:
        cloned = copy.deepcopy(source)
        cloned.attrib["min"] = str(target_column)
        cloned.attrib["max"] = str(target_column)
        columns.append(cloned)


def formula_impacts(root: ET.Element, target_column: int, start_row: int, end_row: int) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    direct: list[dict[str, str]] = []
    adjacent: list[dict[str, str]] = []
    label = column_label(target_column)
    direct_pattern = re.compile(rf"(?<![A-Z0-9_])\$?{label}\$?[1-9][0-9]*", re.IGNORECASE)
    range_pattern = re.compile(r"\$?([A-Z]{1,3})\$?([1-9][0-9]*):\$?([A-Z]{1,3})\$?([1-9][0-9]*)", re.IGNORECASE)
    for cell in root.findall("x:sheetData/x:row/x:c", NS):
        formula = cell.findtext("x:f", default="", namespaces=NS)
        if not formula:
            continue
        item = {"cell": cell.attrib.get("r", ""), "formula": formula}
        if direct_pattern.search(formula):
            direct.append(item)
        for match in range_pattern.finditer(formula):
            last_column = column_number(match.group(3))
            first_row, last_row = int(match.group(2)), int(match.group(4))
            if last_column + 1 == target_column and not (last_row < start_row or first_row > end_row):
                adjacent.append(item)
                break
    return direct, adjacent


def external_formula_references(package: WorkbookPackage, selected_sheet: dict[str, object]) -> list[dict[str, str]]:
    name = str(selected_sheet["name"])
    escaped = name.replace("'", "''")
    tokens = (f"'{escaped}'!".casefold(), f"{name}!".casefold())
    references: list[dict[str, str]] = []
    for sheet in package.sheets:
        if sheet["name"] == name:
            continue
        root = package.xml(str(sheet["path"]))
        for cell in root.findall("x:sheetData/x:row/x:c", NS):
            formula = cell.findtext("x:f", default="", namespaces=NS)
            folded = formula.casefold()
            if formula and any(token in folded for token in tokens):
                references.append(
                    {"sheet": str(sheet["name"]), "cell": cell.attrib.get("r", ""), "formula": formula}
                )
    return references


def defined_name_references(package: WorkbookPackage, sheet_name: str) -> list[dict[str, str]]:
    escaped = sheet_name.replace("'", "''")
    tokens = (f"'{escaped}'!".casefold(), f"{sheet_name}!".casefold())
    references = []
    for defined in package.workbook_root.findall("x:definedNames/x:definedName", NS):
        value = defined.text or ""
        if any(token in value.casefold() for token in tokens):
            references.append({"name": defined.attrib.get("name", ""), "reference": value})
    return references


def extend_print_area(
    package: WorkbookPackage,
    sheet: dict[str, object],
    target_column: int,
    start_row: int,
    end_row: int,
) -> tuple[dict[str, str] | None, str | None]:
    print_area = None
    for defined in package.workbook_root.findall("x:definedNames/x:definedName", NS):
        if defined.attrib.get("name") == "_xlnm.Print_Area" and defined.attrib.get("localSheetId") == str(sheet["index"]):
            print_area = defined
            break
    if print_area is None or not print_area.text:
        return None, "PRINT_AREA_MISSING"
    current = print_area.text
    if current.count("!") != 1 or "," in current:
        return None, "PRINT_AREA_COMPLEX_UNCHANGED"
    prefix, reference = current.rsplit("!", 1)
    normalized = reference.replace("$", "")
    try:
        first_column, first_row, last_column, last_row = parse_range(normalized)
    except WorkbookError:
        return None, "PRINT_AREA_COMPLEX_UNCHANGED"
    if last_column >= target_column:
        return None, None
    if first_row > start_row or last_row < end_row:
        return None, "PRINT_AREA_DOES_NOT_COVER_EDITED_ROWS"
    if last_column + 1 != target_column:
        return None, "PRINT_AREA_EXTENSION_GAP"
    updated_reference = (
        "$" + column_label(first_column) + "$" + str(first_row)
        + ":$" + column_label(target_column) + "$" + str(last_row)
    )
    updated = f"{prefix}!{updated_reference}"
    print_area.text = updated
    return {"from": current, "to": updated}, None


def resolve_target_column(root: ET.Element, shared_strings: list[str], args: dict[str, object], header_row: int, header: str) -> int:
    column = args.get("column")
    if column is not None:
        if isinstance(column, int) and not isinstance(column, bool):
            require(1 <= column <= 16384, "COLUMN_OUT_OF_RANGE")
            return column
        require(isinstance(column, str) and bool(re.fullmatch(r"[A-Za-z]{1,3}", column)), "COLUMN_INVALID")
        return column_number(column)
    matches = []
    for reference, cell in cell_map(root).items():
        cell_column, cell_row = parse_cell(reference)
        if cell_row == header_row and read_cell(cell, shared_strings).get("value") == header:
            matches.append(cell_column)
    require(len(matches) == 1, "HEADER_COLUMN_NOT_UNIQUE", header)
    return matches[0]


def edit_column(content: bytes, args: dict[str, object]) -> tuple[dict[str, object], bytes]:
    package = WorkbookPackage(content)
    sheet = package.sheet(args.get("sheet") if isinstance(args.get("sheet"), str) else "")
    header_row = args.get("headerRow")
    start_row = args.get("startRow")
    end_row = args.get("endRow")
    header = args.get("header")
    values = args.get("values")
    require(isinstance(header_row, int) and 1 <= header_row <= 1_048_576, "HEADER_ROW_INVALID")
    require(isinstance(start_row, int) and isinstance(end_row, int), "EDIT_ROW_RANGE_INVALID")
    require(header_row < start_row <= end_row <= 1_048_576, "EDIT_ROW_RANGE_INVALID")
    require(isinstance(header, str) and bool(header) and len(header) <= 500, "HEADER_INVALID")
    require(isinstance(values, list) and len(values) == end_row - start_row + 1, "EDIT_VALUES_LENGTH_MISMATCH")
    require(all(value is None or isinstance(value, (str, int, float, bool)) for value in values), "EDIT_VALUE_INVALID")
    new_title = args.get("newTitle")
    require(new_title is None or isinstance(new_title, str) and len(new_title) <= 1000, "TITLE_INVALID")
    root = package.xml(str(sheet["path"]))
    target_column = resolve_target_column(root, package.shared_strings, args, header_row, header)
    merges_before = merge_references(root)
    for row in range(header_row, end_row + 1):
        collisions = [reference for reference in merges_before if merged_range_contains(reference, target_column, row)]
        require(not collisions, "EDIT_MERGED_CELL_UNSAFE", collisions[0] if collisions else "")
    existing_cells = cell_map(root)
    for row in range(header_row, end_row + 1):
        existing = existing_cells.get(cell_reference(target_column, row))
        require(existing is None or existing.find("x:f", NS) is None, "EDIT_FORMULA_OVERWRITE_UNSAFE", cell_reference(target_column, row))
    direct_references, adjacent_ranges = formula_impacts(root, target_column, start_row, end_row)
    external_references = external_formula_references(package, sheet)
    name_references = defined_name_references(package, str(sheet["name"]))
    styles = {row: style_for(root, target_column, row) for row in range(header_row, end_row + 1)}
    for row in range(1, header_row):
        remove_cell(root, target_column, row)
    merge_change = extend_title_merge(root, target_column)
    print_area_change, print_area_warning = extend_print_area(package, sheet, target_column, start_row, end_row)
    if new_title is not None:
        set_cell(root, 1, 1, new_title, style_for(root, 1, 1))
    set_cell(root, target_column, header_row, header, styles[header_row])
    for offset, value in enumerate(values):
        set_cell(root, target_column, start_row + offset, value, styles[start_row + offset])
    copy_column_definition(root, target_column)
    update_dimension(root, target_column, end_row)
    sheet_path = str(sheet["path"])
    edited_sheet = serialize_xml(root, package.parts[sheet_path])
    updates = {sheet_path: edited_sheet}
    if print_area_change is not None:
        updates["xl/workbook.xml"] = serialize_xml(package.workbook_root, package.parts["xl/workbook.xml"])
    output = package.write_with_parts(updates)

    reopened = WorkbookPackage(output)
    reopened_sheet = reopened.sheet(str(sheet["name"]))
    verification_root = reopened.xml(str(reopened_sheet["path"]))
    verification_cells = cell_map(verification_root)
    actual_cells = []
    for row in range(header_row, end_row + 1):
        reference = cell_reference(target_column, row)
        actual_cells.append({"cell": reference, **read_cell(verification_cells.get(reference), reopened.shared_strings)})
    title_cell = read_cell(verification_cells.get("A1"), reopened.shared_strings)
    return (
        {
            "sheet": sheet["name"],
            "column": column_label(target_column),
            "formulaReferences": direct_references,
            "externalFormulaReferences": external_references,
            "formulaCoverageWarnings": adjacent_ranges,
            "formulaReferenceChanges": [],
            "definedNameReferences": name_references,
            "titleMergeChange": merge_change,
            "printAreaChange": print_area_change,
            "printAreaWarning": print_area_warning,
            "verification": {
                "sha256": hashlib.sha256(output).hexdigest(),
                "targetCells": actual_cells,
                "title": title_cell.get("value"),
                "merges": merge_references(verification_root),
                "printArea": reopened.print_area(int(reopened_sheet["index"])),
            },
        },
        output,
    )


def main() -> None:
    try:
        request = json.load(sys.stdin)
        require(isinstance(request, dict), "REQUEST_INVALID")
        operation = request.get("operation")
        args = request.get("args", {})
        require(isinstance(args, dict), "ARGS_INVALID")
        encoded = request.get("workbookBase64")
        require(isinstance(encoded, str), "WORKBOOK_BASE64_REQUIRED")
        try:
            content = base64.b64decode(encoded, validate=True)
        except ValueError as error:
            raise WorkbookError("WORKBOOK_BASE64_INVALID") from error
        if operation == "inspect":
            response = {"ok": True, "result": inspect(content, args)}
        elif operation == "audit":
            response = {"ok": True, "result": audit(content, args)}
        elif operation == "edit-column":
            result, output = edit_column(content, args)
            response = {"ok": True, "result": result, "outputBase64": base64.b64encode(output).decode("ascii")}
        else:
            raise WorkbookError("OPERATION_INVALID")
    except WorkbookError as error:
        response = {"ok": False, "error": {"code": error.code, "message": error.message}}
    except Exception as error:  # Keep internal traces out of the protocol.
        response = {"ok": False, "error": {"code": "WORKBOOK_INTERNAL_ERROR", "message": type(error).__name__}}
    json.dump(response, sys.stdout, ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    main()
`;
