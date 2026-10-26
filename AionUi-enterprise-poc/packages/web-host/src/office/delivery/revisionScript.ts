/** Surgical OOXML revision. Unrelated parts remain byte-identical; all writes are staged in memory. */
export const OFFICE_REVISION_PYTHON = String.raw`
W='http://schemas.openxmlformats.org/wordprocessingml/2006/main'
WN={'w':W}

def word_text(element):return ''.join(t.text or '' for t in element.iter('{'+W+'}t'))
def word_structure(parts):
    root=PX.fromstring(parts['word/document.xml']);body=root.find('w:body',WN);styles={}
    if 'word/styles.xml' in parts:
        for style in PX.fromstring(parts['word/styles.xml']).findall('w:style',WN):
            outline=style.find('w:pPr/w:outlineLvl',WN)
            if outline is not None:styles[style.get('{'+W+'}styleId')]=int(outline.get('{'+W+'}val'))+1
    headings=[];paragraphs=[];tables=[]
    for p in body.findall('w:p',WN):
        value=word_text(p);paragraphs.append({'index':len(paragraphs)+1,'text':value})
        ps=p.find('w:pPr/w:pStyle',WN);level=styles.get(ps.get('{'+W+'}val')) if ps is not None else None
        if level:headings.append({'index':len(headings)+1,'level':level,'text':value})
    for t in body.findall('w:tbl',WN):
        rows=t.findall('w:tr',WN)
        tables.append({'index':len(tables)+1,'rows':len(rows),'columns':max((len(r.findall('w:tc',WN)) for r in rows),default=0),'cells':[[word_text(c)[:1500] for c in r.findall('w:tc',WN)[:40]] for r in rows[:100]]})
    return {'format':'docx','headingCount':len(headings),'levelOneHeadingCount':sum(h['level']==1 for h in headings),'headings':headings,'paragraphCount':len(paragraphs),'paragraphs':paragraphs[:200],'tables':tables,'structureTruncated':len(paragraphs)>200 or any(t['rows']>100 or t['columns']>40 for t in tables)}

def read_provenance(parts):
    if PROVENANCE_PART not in parts:return None
    try:return json.loads(PX.fromstring(parts[PROVENANCE_PART]).text or '{}')
    except Exception:raise ValueError('PROVENANCE_INVALID')

def inspect_office(content,format):
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        if len(archive.infolist())>10000 or sum(i.file_size for i in archive.infolist())>209715200:raise ValueError('OFFICE_EXPANSION_LIMIT')
        if archive.testzip() is not None:raise ValueError('OFFICE_CRC_INVALID')
        parts={i.filename:archive.read(i.filename) for i in archive.infolist()}
    provenance=read_provenance(parts)
    if format=='docx':result=word_structure(parts)
    else:
        package=WorkbookPackage(content);sheets=[]
        for item in package.sheets:
            root=package.xml(str(item['path']));cells=cell_map(root);calculator=DecimalEvaluator(root,package.shared_strings);formulas=[]
            for reference,cell in cells.items():
                f=cell.find(Q('f'))
                if f is not None:
                    try:value=decimal_text(calculator.cell(reference));error=None
                    except WorkbookError as problem:value=None;error=problem.code
                    formulas.append({'cell':reference,'formula':f.text,'value':value,'error':error})
            sheets.append({'name':item['name'],'dimension':root.find(Q('dimension')).get('ref') if root.find(Q('dimension')) is not None else None,'formulas':formulas,'hyperlinks':len(root.findall('x:hyperlinks/x:hyperlink',NS)),'printArea':package.print_area(int(item['index']))})
        result={'format':'xlsx','sheets':sheets,'sheetCount':len(sheets)}
    result['sourceCount']=len(provenance.get('sources',[])) if provenance else 0
    result['provenanceStatus']='retained' if provenance else 'not-present'
    return result,parts,provenance

def replace_paragraph(p,find,replacement):
    nodes=list(p.iter('{'+W+'}t'));original=''.join(n.text or '' for n in nodes);count=original.count(find)
    if not count:return 0
    # Work backwards, preserving run formatting outside each exact match.
    starts=[];cursor=0
    while True:
        at=original.find(find,cursor)
        if at<0:break
        starts.append(at);cursor=at+len(find)
    for start in reversed(starts):
        end=start+len(find);position=0;inserted=False
        for node in nodes:
            value=node.text or '';a=position;b=a+len(value);position=b
            if b<=start or a>=end:continue
            left=value[:max(0,start-a)];right=value[max(0,end-a):] if end<b else ''
            node.text=left+(replacement if not inserted else '')+right;node.set('{http://www.w3.org/XML/1998/namespace}space','preserve');inserted=True
    return count

def revise_office(content,format,operations):
    before,parts,provenance=inspect_office(content,format);changes=[]
    if format=='docx':
        root=PX.fromstring(parts['word/document.xml']);body=root.find('w:body',WN)
        original_quotes=[s['quote'] for s in (provenance or {}).get('sources',[]) if s.get('quote')]
        for operation in operations:
            kind=operation['kind']
            if kind=='replace_text':
                find=operation['find'];replacement=operation['replace'];count=0
                for p in root.iter('{'+W+'}p'):count+=replace_paragraph(p,find,replacement)
                if count!=operation.get('expectedOccurrences',1):raise ValueError('REPLACEMENT_COUNT_MISMATCH')
                changes.append({'kind':kind,'occurrences':count,'find':find,'replacement':replacement})
            elif kind=='set_table_cell':
                tables=body.findall('w:tbl',WN)
                if operation['table']>len(tables):raise ValueError('TABLE_INDEX_OUT_OF_RANGE')
                rows=tables[operation['table']-1].findall('w:tr',WN)
                if operation['row']>len(rows):raise ValueError('TABLE_ROW_OUT_OF_RANGE')
                cells=rows[operation['row']-1].findall('w:tc',WN)
                if operation['column']>len(cells):raise ValueError('TABLE_COLUMN_OUT_OF_RANGE')
                cell=cells[operation['column']-1]
                if word_text(cell)!=operation['expected']:raise ValueError('TABLE_CELL_CHANGED')
                paragraphs=cell.findall('w:p',WN)
                if len(paragraphs)!=1:raise ValueError('COMPLEX_CELL_USE_PRECISE_REPLACE_TEXT')
                p=paragraphs[0]
                if not operation['expected']:
                    run=PX.SubElement(p,'{'+W+'}r');PX.SubElement(run,'{'+W+'}t').text=operation['value']
                else:replace_paragraph(p,operation['expected'],operation['value'])
                changes.append({'kind':kind,'table':operation['table'],'row':operation['row'],'column':operation['column'],'before':operation['expected'],'after':operation['value']})
            elif kind=='append_section':
                title=operation['heading']
                if operation.get('numbered') and re.match(r'^(?:第[一二三四五六七八九十百零〇0-9]+[章节]|[0-9]+[.、\s])',title):raise ValueError('NUMBERED_TITLE_MUST_NOT_INCLUDE_INDEX')
                number=word_structure(dict(parts,**{'word/document.xml':PX.tostring(root)}))['levelOneHeadingCount']+1
                heading=(str(number)+' '+title) if operation.get('numbered') else title
                def add(value,style=None):
                    p=PX.Element('{'+W+'}p')
                    if style:
                        props=PX.SubElement(p,'{'+W+'}pPr');PX.SubElement(props,'{'+W+'}pStyle',{'{'+W+'}val':style});PX.SubElement(props,'{'+W+'}keepNext')
                    run=PX.SubElement(p,'{'+W+'}r');PX.SubElement(run,'{'+W+'}t').text=value
                    sect=body.find('w:sectPr',WN);body.insert(list(body).index(sect) if sect is not None else len(body),p)
                add(heading,'Heading1')
                for value in operation['paragraphs']:add(value)
                changes.append({'kind':kind,'actualHeading':heading,'actualLevelOneIndex':number,'addedParagraphs':len(operation['paragraphs'])})
            else:raise ValueError('OPERATION_NOT_FOR_DOCX')
        normalize=lambda s:re.sub(r'\s+','',s)
        old_text=normalize(''.join(word_text(p) for p in PX.fromstring(parts['word/document.xml']).iter('{'+W+'}p')))
        new_text=normalize(''.join(word_text(p) for p in root.iter('{'+W+'}p')))
        for quote in original_quotes:
            q=normalize(quote)
            if old_text.count(q)!=new_text.count(q):raise ValueError('VERIFIED_SOURCE_QUOTE_CHANGED_REGENERATE_WITH_CURRENT_EVIDENCE')
        parts['word/document.xml']=PX.tostring(root,encoding='utf-8',xml_declaration=True)
    else:
        package=WorkbookPackage(content)
        for operation in operations:
            if operation['kind']!='set_cell':raise ValueError('OPERATION_NOT_FOR_XLSX')
            if provenance and operation['sheet'] in ['资料来源','证据摘录']:raise ValueError('SOURCE_CATALOG_READ_ONLY')
            item=package.sheet(operation['sheet']);root=package.xml(str(item['path']));reference=operation['cell'].upper();column,row=parse_cell(reference);cells=cell_map(root)
            old=read_cell(cells.get(reference),package.shared_strings)
            if old['kind']=='formula':raise ValueError('FORMULA_CELL_READ_ONLY_USE_STRUCTURED_CALCULATION')
            actual=old.get('value')
            expected=operation.get('expected')
            if old['kind']=='number':equal=Decimal(str(actual))==Decimal(str(expected)) if isinstance(expected,(int,float)) and not isinstance(expected,bool) else False
            elif old['kind']=='blank':equal=expected is None
            else:equal=actual==expected
            if not equal:raise ValueError('CELL_CHANGED_READ_CURRENT_VALUE')
            dimension=root.find(Q('dimension'));bounds=parse_range(dimension.get('ref')) if dimension is not None and ':' in dimension.get('ref','') else None
            if reference not in cells and (not bounds or not(bounds[0]<=column<=bounds[2] and bounds[1]<=row<=bounds[3])):raise ValueError('CELL_OUTSIDE_EXISTING_RANGE')
            set_cell(root,column,row,operation['value'],style_for(root,column,row))
            package.parts[str(item['path'])]=ET.tostring(root,encoding='utf-8',xml_declaration=True)
            changes.append({'kind':'set_cell','sheet':operation['sheet'],'cell':reference,'before':actual,'after':operation['value']})
        parts=package.parts
    out=io.BytesIO()
    with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as archive:
        for name,value in parts.items():archive.writestr(name,value)
    output=recalculate_office_formulas(out.getvalue()) if format=='xlsx' else out.getvalue()
    if provenance:
        provenance.setdefault('revisions',[]).append({'previousSha256':hashlib.sha256(content).hexdigest(),'changes':changes,'sourceFactsReverified':False})
        output=put_provenance(output,provenance)
    after,_,_=inspect_office(output,format)
    return output,{'before':before,'after':after,'changes':changes,'sourceFactsReverified':False,'unrequestedPartsPreserved':True}
`;
