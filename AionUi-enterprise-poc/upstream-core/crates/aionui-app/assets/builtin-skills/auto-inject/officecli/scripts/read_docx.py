"""Extract readable DOCX text and table cells with the Python standard library.

This is a read-only fallback for employee Core environments without officecli.
It does not render images, page layout, tracked deletions, or embedded objects.
"""

import sys
from pathlib import Path
from xml.etree import ElementTree
from zipfile import BadZipFile, ZipFile


W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
MAX_PART_BYTES = 32 * 1024 * 1024
MAX_TOTAL_BYTES = 64 * 1024 * 1024


def paragraph_text(paragraph):
    parts = []
    for element in paragraph.iter():
        if element.tag == W + "t":
            parts.append(element.text or "")
        elif element.tag == W + "tab":
            parts.append("\t")
        elif element.tag in (W + "br", W + "cr"):
            parts.append("\n")
    return "".join(parts).strip()


def block_lines(parent):
    for child in parent:
        if child.tag == W + "p":
            value = paragraph_text(child)
            if value:
                yield value
        elif child.tag == W + "tbl":
            for row in child.findall(W + "tr"):
                cells = []
                for cell in row.findall(W + "tc"):
                    cells.append(" / ".join(block_lines(cell)))
                if any(cells):
                    yield " | ".join(cells)


def main(file_path):
    if file_path.suffix.lower() != ".docx" or not file_path.is_file():
        raise ValueError("expected an existing .docx file")
    with ZipFile(file_path) as archive:
        names = ["word/document.xml"]
        names += sorted(
            name for name in archive.namelist()
            if name.startswith("word/")
            and name.endswith(".xml")
            and Path(name).name.startswith(("header", "footer", "footnotes", "endnotes"))
        )
        total = 0
        found = False
        in_supplement = False
        for name in names:
            try:
                info = archive.getinfo(name)
            except KeyError:
                continue
            if info.file_size > MAX_PART_BYTES or total + info.file_size > MAX_TOTAL_BYTES:
                raise ValueError("DOCX XML exceeds extraction size limit")
            data = archive.read(info)
            total += len(data)
            root = ElementTree.fromstring(data)
            body = root.find(W + "body") if name == "word/document.xml" else root
            if body is None:
                continue
            lines = list(block_lines(body))
            if name != "word/document.xml" and lines and not in_supplement:
                print("[Headers, footers and notes]")
                in_supplement = True
            for line in lines:
                print(line)
                found = True
        if not found:
            raise ValueError("no extractable text found; the document may contain scanned images")


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise ValueError("usage: read_docx.py FILE.docx")
        main(Path(sys.argv[1]))
    except (BadZipFile, ElementTree.ParseError, OSError, ValueError) as error:
        print(f"DOCX extraction failed: {error}", file=sys.stderr)
        sys.exit(1)
