#!/usr/bin/env python3
"""Read-only validation of native Office delivery pairs; no model/network/shell dependencies."""
import argparse, collections, hashlib, json, re, zipfile, sys, posixpath
from decimal import Decimal
from datetime import datetime, timedelta
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
            topics=[re.sub(r'\s*\[S\d+\]$','',re.sub(r'^\d+\s+','',lines[i-1])) for i,x in enumerate(lines) if x.startswith('核查结论：') and i>0]
            text = '\n'.join(lines)
            metrics=[]
            for table in doc.findall('.//w:tbl', ns):
                rows=[[''.join(t.text or '' for t in c.findall('.//w:t',ns)) for c in row.findall('w:tc',ns)] for row in table.findall('w:tr',ns)]
                if rows and rows[0][:1]==['对象与参数']:metrics.extend(rows[1:])

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
            rels={r.get('Id'):r.get('Target') for r in ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))}
            book=ET.fromstring(z.read('xl/workbook.xml'));sheets={}
            styles=ET.fromstring(z.read('xl/styles.xml'))
            formats={x.get('numFmtId'):x.get('formatCode','') for x in styles.findall('x:numFmts/x:numFmt',ns)}
            xfs=styles.findall('x:cellXfs/x:xf',ns)
            for sheet in book.findall('x:sheets/x:sheet',ns):
                rid=sheet.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id');target=rels[rid]
                part=target.lstrip('/') if target.startswith('/') else posixpath.normpath('xl/'+target)
                matrix=[]
                for row in ET.fromstring(z.read(part)).findall('x:sheetData/x:row',ns):
                    values={}
                    for c in row.findall('x:c',ns):
                        v=c.find('x:v',ns);raw=v.text if v is not None else ''
                        if c.get('t')=='s':raw=strings[int(raw)]
                        elif c.get('t')=='inlineStr':raw=''.join(t.text or '' for t in c.findall('.//x:t',ns))
                        elif raw and c.get('t','n')=='n':
                            fmt=formats.get(xfs[int(c.get('s','0'))].get('numFmtId'),'') if xfs else ''
                            if 'yyyy' in fmt.lower() and 'mm' in fmt.lower():raw=(datetime(1899,12,30)+timedelta(days=float(raw))).strftime('%Y-%m-%d')
                            else:raw=format(Decimal(raw).normalize(),'f')
                        values[re.sub('[0-9]','',c.get('r'))]=raw
                    matrix.append(values)
                sheets[sheet.get('name')]=matrix
            review=sheets.get('核查清单',[])
            header=next((i for i,r in enumerate(review) if r.get('B')=='核查要求'),None)
            statuses=[r.get('C') for r in review[header+1:] if r.get('C') in STATUS] if header is not None else []
            topics=[r.get('B','') for r in review[header+1:] if r.get('C') in STATUS] if header is not None else []
            parameters=sheets.get('参数对比',[]);metrics=[]
            header=next((i for i,r in enumerate(parameters) if r.get('C')=='参数或主题'),None)
            if header is not None:
                for r in parameters[header+1:]:
                    if r.get('B'):metrics.append([r.get('B','')+' · '+r.get('C',''),r.get('D','')+' '+r.get('E',''),r.get('F','')])
        else:
            raise ValueError('EXPECTED_DOCX_OR_XLSX')
        if not provenance.get('dataSha256') and not provenance.get('resultHash'):
            raise ValueError('NO_SHARED_VERIFIED_DATA_ID')
        return {'sha256': hashlib.sha256(p.read_bytes()).hexdigest(), 'provenance': provenance,
                'text': text, 'statuses': statuses, 'metrics': metrics, 'findingTopics': topics}

def validate(docx, xlsx, expected=None):
    word, excel = package(docx), package(xlsx)
    core = lambda value: {key: item for key, item in value.items() if key != 'revisions'}
    if core(word['provenance']) != core(excel['provenance']):
        raise ValueError('PAIR_PROVENANCE_MISMATCH')
    revision_review = word['provenance'].get('revisions', []) != excel['provenance'].get('revisions', [])
    if word['findingTopics'] != excel['findingTopics']:
        raise ValueError('PAIR_CHECKLIST_TOPIC_MISMATCH')
    if word['statuses'] != excel['statuses']:
        raise ValueError('PAIR_CHECKLIST_STATUS_MISMATCH')
    compact=lambda value: re.sub(r'\s+','',value)
    if word['metrics'] and [[compact(x).strip('[]') if i==2 else compact(x) for i,x in enumerate(row)] for row in word['metrics']] != [[compact(x).strip('[]') if i==2 else compact(x) for i,x in enumerate(row)] for row in excel['metrics']]:
        raise ValueError('PAIR_PARAMETER_VALUE_MISMATCH')
    if 'formalCount' in (expected or {}) and len(word['statuses']) != expected['formalCount']:
        raise ValueError('FORMAL_REQUIREMENT_COUNT_MISMATCH')
    for required in (expected or {}).get('requiredText', []):
        if required not in word['text'] or required not in excel['text']:
            raise ValueError('EXPECTED_FACT_MISSING:' + required)
    return {'status': 'REVIEW_REQUIRED' if revision_review else 'PASS', 'revisionContentReviewRequired': revision_review, 'docxSha256': word['sha256'], 'xlsxSha256': excel['sha256'],
            'dataId': word['provenance'].get('dataSha256') or word['provenance'].get('resultHash'),
            'wordStatuses': dict(collections.Counter(word['statuses'])),
            'boundary': 'Native content/provenance/pair checks, not proof of legal compliance or customer acceptance.'}

if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('docx'); parser.add_argument('xlsx'); parser.add_argument('--expected')
    a = parser.parse_args(); expected = json.loads(Path(a.expected).read_text()) if a.expected else None
    result = validate(a.docx, a.xlsx, expected)
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(2 if result['status'] == 'REVIEW_REQUIRED' else 0)
