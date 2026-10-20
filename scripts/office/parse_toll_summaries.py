#!/usr/bin/env python3
"""Parse Chinese ETC toll summary PDFs into a reimbursement manifest.

The parser is deliberately strict: it accepts the two official summary layouts
(invoice-indexed and trip-indexed) only when header, detail, and footer totals
close.  It does not infer missing business facts.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import resource
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Iterable


MAX_FILE_BYTES = 50 * 1024 * 1024
MAX_PAGES = 20
MAX_INPUT_FILES = 20
MAX_TOTAL_INPUT_BYTES = 200 * 1024 * 1024
MAX_EXTRACTED_TEXT_BYTES = 8 * 1024 * 1024
MAX_MANIFEST_BYTES = 8 * 1024 * 1024
PDFTOTEXT_TIMEOUT_SECONDS = 30
MONEY = Decimal("0.01")


class ParseError(ValueError):
    """The source is unsupported, ambiguous, or internally inconsistent."""


@dataclass(frozen=True)
class Invoice:
    sequence: int
    number: str
    amount: Decimal
    tax_rate: str
    tax_amount: Decimal
    page: int


@dataclass(frozen=True)
class Trip:
    sequence: int
    date: str
    amount: Decimal
    page: int


def _money(value: str, field: str) -> Decimal:
    try:
        result = Decimal(value.replace(",", "")).quantize(MONEY)
    except (InvalidOperation, AttributeError) as exc:
        raise ParseError(f"invalid {field}: {value!r}") from exc
    if result < 0:
        raise ParseError(f"negative {field}: {value!r}")
    return result


def _iso_date(value: str, field: str) -> str:
    raw = value.replace("/", "-")
    if re.fullmatch(r"\d{8}", raw):
        raw = f"{raw[:4]}-{raw[4:6]}-{raw[6:]}"
    try:
        return dt.date.fromisoformat(raw).isoformat()
    except ValueError as exc:
        raise ParseError(f"invalid {field}: {value!r}") from exc


def _unique_match(pattern: str, text: str, field: str, flags: int = 0) -> str:
    values = {m.group(1).strip() for m in re.finditer(pattern, text, flags)}
    if len(values) != 1:
        raise ParseError(f"expected one unambiguous {field}, found {sorted(values)!r}")
    return values.pop()


def _split_pages(text: str) -> list[str]:
    pages = text.split("\f")
    if pages and not pages[-1].strip():
        pages.pop()
    return pages or [text]


def extract_pdf_text(path: Path) -> tuple[str, int, str]:
    """Extract at most 21 pages with a fixed, non-configurable pdftotext argv."""
    path = path.expanduser().resolve(strict=True)
    if not path.is_file() or path.suffix.lower() != ".pdf":
        raise ParseError(f"source is not a PDF file: {path}")
    size = path.stat().st_size
    if size > MAX_FILE_BYTES:
        raise ParseError(f"PDF exceeds {MAX_FILE_BYTES} bytes: {path}")
    if size == 0:
        raise ParseError(f"empty PDF: {path}")

    executable = shutil.which("pdftotext")
    if not executable:
        raise ParseError("pdftotext is required but was not found on PATH")
    with tempfile.TemporaryDirectory(prefix="toll-pdftotext-") as temp_dir:
        extracted = Path(temp_dir) / "extracted.txt"
        stderr_path = Path(temp_dir) / "stderr.txt"
        argv = [
            executable,
            "-layout",
            "-enc",
            "UTF-8",
            "-f",
            "1",
            "-l",
            str(MAX_PAGES + 1),
            str(path),
            str(extracted),
        ]

        def limit_output_file_size() -> None:
            resource.setrlimit(
                resource.RLIMIT_FSIZE,
                (MAX_EXTRACTED_TEXT_BYTES, MAX_EXTRACTED_TEXT_BYTES),
            )

        try:
            with stderr_path.open("wb") as stderr_handle:
                proc = subprocess.run(
                    argv,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=stderr_handle,
                    timeout=PDFTOTEXT_TIMEOUT_SECONDS,
                    check=False,
                    preexec_fn=limit_output_file_size,
                )
        except subprocess.TimeoutExpired as exc:
            raise ParseError(
                f"pdftotext timed out after {PDFTOTEXT_TIMEOUT_SECONDS}s: {path}"
            ) from exc
        with stderr_path.open("rb") as stderr_handle:
            detail = stderr_handle.read(500).decode("utf-8", "replace").strip()
        if proc.returncode != 0:
            raise ParseError(f"pdftotext failed for {path}: {detail or 'unknown error'}")
        if not extracted.is_file():
            raise ParseError(f"pdftotext produced no output file: {path}")
        if extracted.stat().st_size > MAX_EXTRACTED_TEXT_BYTES:
            raise ParseError(
                f"pdftotext output exceeds {MAX_EXTRACTED_TEXT_BYTES} bytes: {path}"
            )
        raw_text = extracted.read_bytes()
    try:
        text = raw_text.decode("utf-8", "strict")
    except UnicodeDecodeError as exc:
        raise ParseError(f"pdftotext did not return valid UTF-8: {path}") from exc
    pages = _split_pages(text)
    if len(pages) > MAX_PAGES:
        raise ParseError(f"PDF exceeds {MAX_PAGES} pages: {path}")
    if not text.strip():
        raise ParseError(f"PDF has no extractable text layer: {path}")
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    return text, len(pages), digest


def _parse_invoices(pages: list[str]) -> list[Invoice]:
    # Official summaries concatenate the 20-digit invoice number and amount in
    # layout text, e.g. 123...9012 + 18.78. A repeated "same invoice" reference
    # has '-' instead of an amount and therefore does not match.
    pattern = re.compile(
        r"(?:^|\s)(\d{1,3})\s+\*\s+(\d{20})[ \t]*(\d{1,9}\.\d{2})"
        r"\s+(\d+(?:\.\d+)?)%\s+(\d{1,9}\.\d{2})(?=\s|$)",
        re.MULTILINE,
    )
    found: dict[str, Invoice] = {}
    for page_no, page in enumerate(pages, 1):
        for match in pattern.finditer(page):
            item = Invoice(
                sequence=int(match.group(1)),
                number=match.group(2),
                amount=_money(match.group(3), "invoice amount"),
                tax_rate=match.group(4) + "%",
                tax_amount=_money(match.group(5), "invoice tax"),
                page=page_no,
            )
            previous = found.get(item.number)
            if previous and (
                previous.amount,
                previous.tax_rate,
                previous.tax_amount,
            ) != (item.amount, item.tax_rate, item.tax_amount):
                raise ParseError(f"invoice {item.number} has conflicting detail rows")
            if not previous:
                found[item.number] = item
    return sorted(found.values(), key=lambda item: item.sequence)


def _parse_trips(pages: list[str], summary_number: str, layout: str) -> list[Trip]:
    row = re.compile(r"^\s*(\d{1,3})\s+(.*)$")
    date_token = re.compile(r"(?<!\d)(\d{8})(?!\d)")
    amount = re.compile(r"(?<![\d.])(\d{1,9}\.\d{2})(?!\d)")
    found: dict[str, Trip] = {}
    for page_no, page in enumerate(pages, 1):
        lines = page.splitlines()
        for line_index, line in enumerate(lines):
            match = row.match(line)
            if not match:
                continue
            leading = len(line) - len(line.lstrip())
            # In invoice-index layout the trip table is the right-hand table;
            # invoice rows begin near column 1 and must not be mistaken for trips.
            if layout == "invoice_index" and leading < 20:
                continue
            amounts = amount.findall(match.group(2))
            if not amounts:
                continue
            dates = date_token.findall(match.group(2))
            if not dates:
                # Poppler's -layout output puts the trip's start date on the
                # immediately preceding physical line. Look back only within
                # the current row block so an unrelated date cannot be used.
                for previous_index in range(line_index - 1, max(-1, line_index - 5), -1):
                    dates = date_token.findall(lines[previous_index])
                    if dates:
                        break
            if len(set(dates)) != 1:
                raise ParseError(
                    f"trip row {match.group(1)} on page {page_no} has no unambiguous business date"
                )
            # In trip-index layout, invoice columns may continue on the same
            # physical line, so the transaction amount is the first decimal.
            # In invoice-index layout, split amount precedes transaction amount.
            selected_amount = amounts[0] if layout == "trip_index" else amounts[-1]
            item = Trip(
                sequence=int(match.group(1)),
                date=_iso_date(dates[0], "trip business date"),
                amount=_money(selected_amount, "trip amount"),
                page=page_no,
            )
            key = f"{summary_number}:{item.sequence}"
            previous = found.get(key)
            if previous and (previous.date, previous.amount) != (item.date, item.amount):
                raise ParseError(f"transaction reference {key} has conflicting rows")
            if not previous:
                found[key] = item
    return sorted(found.values(), key=lambda item: item.sequence)


def _footer_value(text: str, unit: str) -> tuple[int, Decimal]:
    pattern = rf"共\s*(\d+)\s*{unit}\s*[\s\S]{{0,80}}?[¥￥]\s*(\d{{1,12}}(?:\.\d{{1,2}})?)"
    values = {
        (int(m.group(1)), _money(m.group(2), f"footer {unit} total"))
        for m in re.finditer(pattern, text)
    }
    if len(values) != 1:
        raise ParseError(f"expected one unambiguous footer for {unit}, found {sorted(values)!r}")
    return values.pop()


def parse_document(text: str, source_path: Path, sha256: str, page_count: int) -> dict:
    pages = _split_pages(text)
    if page_count != len(pages):
        raise ParseError("page count does not match extracted page boundaries")
    compact = re.sub(r"[（(]\s*", "(", text)
    compact = re.sub(r"\s*[）)]", ")", compact)
    markers = []
    if re.search(r"\(按\s*票据\s*索引\)", compact):
        markers.append("invoice_index")
    if re.search(r"\(按\s*行程\s*索引\)", compact):
        markers.append("trip_index")
    if len(markers) != 1:
        raise ParseError(f"unsupported or ambiguous ETC summary layout: {markers!r}")
    if "收费公路通行费电子票据汇总单" not in re.sub(r"\s+", "", text):
        raise ParseError("document title is not an ETC toll electronic-invoice summary")

    summary_number = _unique_match(r"汇总单号\s*[:：]\s*(\d{10,30})", text, "summary number")
    application_date = _iso_date(
        _unique_match(
            r"开票申请日期\s*[:：]\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2})",
            text,
            "invoice application date",
        ),
        "invoice application date",
    )
    total = _money(
        _unique_match(r"交易金额\s*[:：]?\s*[¥￥]?\s*(\d{1,12}(?:\.\d{1,2})?)", text, "header total"),
        "header total",
    )
    trip_count = int(_unique_match(r"行程数量\s*[:：]?\s*(\d+)", text, "trip count"))
    invoice_count = int(_unique_match(r"票据数量\s*[:：]?\s*(\d+)", text, "invoice count"))
    plate = _unique_match(r"车牌号码\s*[:：]?\s*([^\s]+)", text, "plate number")
    buyer_tax_id = _unique_match(r"纳税人识别号\s*[:：]?\s*([0-9A-Z]{15,20})", text, "buyer tax id")
    buyer_name = _unique_match(
        r"购买方名称\s*[:：]?\s*(.+?)(?=\n|纳税人识别号)", text, "buyer name"
    )

    invoices = _parse_invoices(pages)
    trips = _parse_trips(pages, summary_number, markers[0])
    if len(invoices) != invoice_count:
        raise ParseError(f"invoice count does not close: header={invoice_count}, detail={len(invoices)}")
    if len(trips) != trip_count:
        raise ParseError(f"trip count does not close: header={trip_count}, detail={len(trips)}")
    invoice_total = sum((item.amount for item in invoices), Decimal("0.00"))
    trip_total = sum((item.amount for item in trips), Decimal("0.00"))
    if invoice_total != total:
        raise ParseError(f"invoice amounts do not close: header={total}, detail={invoice_total}")
    if trip_total != total:
        raise ParseError(f"trip amounts do not close: header={total}, detail={trip_total}")
    footer_invoice_count, footer_invoice_total = _footer_value(text, "张票据")
    footer_trip_count, footer_trip_total = _footer_value(text, "段行程")
    if (footer_invoice_count, footer_invoice_total) != (invoice_count, total):
        raise ParseError("invoice footer does not close against the header")
    if (footer_trip_count, footer_trip_total) != (trip_count, total):
        raise ParseError("trip footer does not close against the header")

    daily: dict[str, Decimal] = {}
    for trip in trips:
        daily[trip.date] = daily.get(trip.date, Decimal("0.00")) + trip.amount
    if sum(daily.values(), Decimal("0.00")) != total:
        raise ParseError("daily trip amounts do not close against the header")
    return {
        "source_path": str(source_path.resolve()),
        "source_name": source_path.name,
        "sha256": sha256,
        "page_count": page_count,
        "layout": markers[0],
        "summary_number": summary_number,
        "application_date": application_date,
        "plate_number": plate,
        "buyer_name": buyer_name,
        "buyer_tax_id": buyer_tax_id,
        "total": total,
        "daily": daily,
        "trips": trips,
        "invoices": invoices,
    }


def _num(value: Decimal) -> float:
    return float(value.quantize(MONEY))


def build_manifest(documents: Iterable[dict]) -> dict:
    docs: list[dict] = []
    hashes: set[str] = set()
    summaries: dict[str, str] = {}
    invoice_owner: dict[str, str] = {}
    invoice_rows: list[dict] = []
    expenses: list[dict] = []
    pending: list[dict] = []

    for doc in documents:
        if doc["sha256"] in hashes:
            continue
        hashes.add(doc["sha256"])
        old_hash = summaries.get(doc["summary_number"])
        if old_hash and old_hash != doc["sha256"]:
            raise ParseError(f"summary {doc['summary_number']} appears in different source files")
        summaries[doc["summary_number"]] = doc["sha256"]
        for invoice in doc["invoices"]:
            owner = invoice_owner.get(invoice.number)
            if owner and owner != doc["summary_number"]:
                raise ParseError(
                    f"invoice {invoice.number} appears in multiple summaries; transaction overlap is ambiguous"
                )
            invoice_owner[invoice.number] = doc["summary_number"]
            invoice_rows.append(
                {
                    "digital_invoice_number": invoice.number,
                    "invoice_code": "",
                    "invoice_number": invoice.number,
                    "invoice_date": "",
                    "amount": _num(invoice.amount),
                    "tax_amount": _num(invoice.tax_amount),
                    "deductible_tax": "",
                    "buyer_tax_id": doc["buyer_tax_id"],
                    "seller_name": "",
                    "seller_tax_id": "",
                    "source": doc["source_path"],
                    "invoice_type": "收费公路通行费电子票据",
                    "status": "",
                    "red_lock": "",
                    "checked_at": "",
                    "business_type": "车辆通行费",
                    "source_trace": {
                        "sha256": doc["sha256"],
                        "page": invoice.page,
                        "summary_number": doc["summary_number"],
                        "application_date": doc["application_date"],
                    },
                }
            )
        dates = sorted(doc["daily"])
        expense_id = "toll-" + doc["summary_number"]
        expenses.append(
            {
                "id": expense_id,
                "expense_type": "self_drive",
                "date": dates[0],
                "summary_date": dates[0],
                "business_dates": dates,
                "daily_amounts": [
                    {"date": date, "amount": _num(doc["daily"][date])} for date in dates
                ],
                "purpose": "",
                "company": doc["buyer_name"],
                "origin": "",
                "destination": "",
                "distance_km": "",
                "parking": 0.0,
                "toll": _num(doc["total"]),
                "remark": f"ETC通行费汇总单 {doc['summary_number']}（{doc['plate_number']}）",
                "summary_remark": f"ETC通行费汇总单 {doc['summary_number']}",
                "evidence": {"toll": [doc["source_path"]]},
                "source_trace": {
                    "sha256": doc["sha256"],
                    "pages": sorted({trip.page for trip in doc["trips"]}),
                    "summary_number": doc["summary_number"],
                    "application_date": doc["application_date"],
                    "transaction_references": [
                        f"{doc['summary_number']}:{trip.sequence}" for trip in doc["trips"]
                    ],
                },
            }
        )
        issues = [
            "未核实该汇总单与审批单或报销申请的关联",
            "未核实票据及行程是否已在历史报销中使用，提交前须查重",
            "未核实是否存在退款、红冲、作废或后续冲销",
            "汇总单未提供办事或出行事由",
            "汇总单未提供可确认的完整起点和终点",
            "汇总单未提供导航里程，无法计算自驾里程补贴",
            "开票申请日期不等于票据开票日期，票据开票日期尚未独立核实",
        ]
        pending.extend(
            {
                "expense_type": "self_drive",
                "id": expense_id,
                "issue": issue,
                "source": doc["source_path"],
            }
            for issue in issues
        )
        docs.append(
            {
                "path": doc["source_path"],
                "sha256": doc["sha256"],
                "pages": doc["page_count"],
                "layout": doc["layout"],
                "summary_number": doc["summary_number"],
                "application_date": doc["application_date"],
                "business_dates": dates,
                "amount": _num(doc["total"]),
                "invoice_count": len(doc["invoices"]),
                "trip_count": len(doc["trips"]),
            }
        )
    if not docs:
        raise ParseError("no unique ETC summary documents were supplied")
    invoice_rows.sort(key=lambda row: (row["source_trace"]["summary_number"], row["invoice_number"]))
    return {
        "metadata": {
            "employee_name": "",
            "period": "",
            "report_date": "",
            "default_subsidy_rate": 1.0,
            "summary_mode": "daily_business_date",
            "generator": "parse_toll_summaries.py",
            "source_documents": docs,
        },
        "expenses": expenses,
        "invoices": invoice_rows,
        "receipt_attachments": [doc["path"] for doc in docs],
        "pending": pending,
    }


def _write_private_json(path: Path, data: dict) -> None:
    path = path.expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = (json.dumps(data, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    if len(payload) > MAX_MANIFEST_BYTES:
        raise ParseError(f"manifest exceeds {MAX_MANIFEST_BYTES} bytes")
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def run(paths: Iterable[Path], output: Path) -> dict:
    paths = list(paths)
    if not paths:
        raise ParseError("at least one input PDF is required")
    if len(paths) > MAX_INPUT_FILES:
        raise ParseError(f"at most {MAX_INPUT_FILES} input PDFs are allowed")
    total_size = 0
    for path in paths:
        try:
            total_size += path.expanduser().resolve(strict=True).stat().st_size
        except OSError as exc:
            raise ParseError(f"cannot read input PDF {path}: {exc}") from exc
    if total_size > MAX_TOTAL_INPUT_BYTES:
        raise ParseError(f"input PDFs exceed {MAX_TOTAL_INPUT_BYTES} bytes in total")
    parsed = []
    for path in paths:
        text, pages, digest = extract_pdf_text(path)
        parsed.append(parse_document(text, path, digest, pages))
    manifest = build_manifest(parsed)
    _write_private_json(output, manifest)
    return manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pdf", nargs="+", type=Path, help="ETC summary PDF path(s)")
    parser.add_argument("--output", required=True, type=Path, help="manifest JSON output path")
    args = parser.parse_args(argv)
    try:
        manifest = run(args.pdf, args.output)
    except (OSError, ParseError) as exc:
        parser.exit(2, f"error: {exc}\n")
    print(
        json.dumps(
            {
                "output": str(args.output.resolve()),
                "documents": len(manifest["metadata"]["source_documents"]),
                "expenses": len(manifest["expenses"]),
                "invoices": len(manifest["invoices"]),
                "pending": len(manifest["pending"]),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
