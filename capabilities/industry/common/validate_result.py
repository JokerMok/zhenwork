#!/usr/bin/env python3
"""Read-only validation of native Office delivery pairs; no model/network/shell dependencies."""
import argparse, collections, hashlib, json, re, zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

LIMIT = 20 * 1024 * 1024
STATUS = {'符合', '不符合', '部分符合', '证据不足'}

def package(path):
    p = Path(path)
    if p.stat().st_size > LIMIT:
        raise ValueError('FILE_LIMIT_20MB')
    with zipfile.ZipFile(p) as z:
        if len(z.infolist()) > 2000 or sum(x.file_size for x in z.infolist()) > 100 * 1024 * 1024:
            raise ValueError('EXPANDED_FILE_LIMIT')
        provenance = json.loads(ET.fromstring(z.read('customXml/zhenwork-provenance.xml')).text)
        if p.suffix.lower() == '.docx':
            doc = ET.fromstring(z.read('word/document.xml'))
            ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
            lines = [''.join(x.itertext()) for x in []]
            lines = [''.join(t.text or '' for t in para.findall('.//w:t', ns)) for para in doc.findall('.//w:p', ns)]
            statuses = [x.removeprefix('核查结论：') for x in lines if x.startswith('核查结论：')]
            text = '\n'.join(lines)
        elif p.suffix.lower() == '.xlsx':
            ns = {'x': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
            strings = []
            if 'xl/sharedStrings.xml' in z.namelist():
                strings = [''.join(t.text or '' for t in item.findall('.//x:t', ns)) for item in ET.fromstring(z.read('xl/sharedStrings.xml'))]
            cells = []
            for name in z.namelist():
                if not re.fullmatch(r'xl/worksheets/sheet\d+\.xml', name): continue
                for c in ET.fromstring(z.read(name)).findall('.//x:c', ns):
                    value = c.find('x:v', ns)
                    if c.get('t') == 's' and value is not None: cells.append(strings[int(value.text)])
                    elif c.get('t') == 'inlineStr': cells.append(''.join(t.text or '' for t in c.findall('.//x:t', ns)))
                    elif value is not None: cells.append(value.text or '')
            text = '\n'.join(cells)
            # A compliance checklist contains every finding even when the separate parameter sheet uses numbers.
            statuses = [x for x in cells if x in STATUS]
        else:
            raise ValueError('EXPECTED_DOCX_OR_XLSX')
        if not provenance.get('dataSha256') and not provenance.get('resultHash'):
            raise ValueError('NO_SHARED_VERIFIED_DATA_ID')
        return {'sha256': hashlib.sha256(p.read_bytes()).hexdigest(), 'provenance': provenance,
                'text': text, 'statuses': statuses}

def validate(docx, xlsx, expected=None):
    word, excel = package(docx), package(xlsx)
    if word['provenance'] != excel['provenance']:
        raise ValueError('PAIR_PROVENANCE_MISMATCH')
    if word['statuses'] and any(collections.Counter(excel['statuses'])[s] < count for s, count in collections.Counter(word['statuses']).items()):
        raise ValueError('PAIR_CHECKLIST_STATUS_MISSING')
    for required in (expected or {}).get('requiredText', []):
        if required not in word['text'] or required not in excel['text']:
            raise ValueError('EXPECTED_FACT_MISSING:' + required)
    return {'status': 'PASS', 'docxSha256': word['sha256'], 'xlsxSha256': excel['sha256'],
            'dataId': word['provenance'].get('dataSha256') or word['provenance'].get('resultHash'),
            'wordStatuses': dict(collections.Counter(word['statuses'])),
            'boundary': 'Native content/provenance/pair checks, not proof of legal compliance or customer acceptance.'}

if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('docx'); parser.add_argument('xlsx'); parser.add_argument('--expected')
    a = parser.parse_args(); expected = json.loads(Path(a.expected).read_text()) if a.expected else None
    print(json.dumps(validate(a.docx, a.xlsx, expected), ensure_ascii=False))
