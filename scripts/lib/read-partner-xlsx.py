"""XLSX display text reader using only Python's standard library (local only)."""
import json
import posixpath
import sys
import zipfile
import xml.etree.ElementTree as ET

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"


def display_text(element):
    # Phonetic annotations (rPh) are not part of the cell's displayed value.
    return "".join((node.text or "") for node in element.findall("m:t", NS) + element.findall("m:r/m:t", NS))


def read(path, sheet_name):
    with zipfile.ZipFile(path) as archive:
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        sheets = workbook.find("m:sheets", NS)
        sheet = next((s for s in sheets if s.get("name") == sheet_name), None)
        if sheet is None:
            raise ValueError("指定したシートがありません")
        relationships = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        target = next(r.get("Target") for r in relationships if r.get("Id") == sheet.get(REL))
        target = target.lstrip("/") if target.startswith("/") else posixpath.normpath("xl/" + target)
        shared = []
        if "xl/sharedStrings.xml" in archive.namelist():
            shared = [display_text(s) for s in ET.fromstring(archive.read("xl/sharedStrings.xml"))]
        rows = []
        for row in ET.fromstring(archive.read(target)).findall("m:sheetData/m:row", NS):
            cells = {}
            for cell in row.findall("m:c", NS):
                address = cell.get("r", "")
                column = "".join(c for c in address if c.isalpha())
                value = cell.find("m:v", NS)
                text = value.text or "" if value is not None else ""
                if cell.get("t") == "s":
                    text = shared[int(text)] if text else ""
                elif cell.get("t") == "inlineStr":
                    inline = cell.find("m:is", NS)
                    text = display_text(inline) if inline is not None else ""
                cells[column] = text
            rows.append({"row": int(row.get("r")), "cells": cells})
        return {"sheet": sheet_name, "rows": rows}


if __name__ == "__main__":
    print(json.dumps(read(sys.argv[1], sys.argv[2]), ensure_ascii=False))
