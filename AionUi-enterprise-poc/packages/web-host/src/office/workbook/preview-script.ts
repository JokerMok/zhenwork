/** Reuses the audited OOXML/Decimal reader; never trusts a stale formula cache. */
export const WORKBOOK_PREVIEW_SCRIPT = String.raw`
def preview(content, args):
    try:
        import resource
        resource.setrlimit(resource.RLIMIT_AS,(384*1024*1024,384*1024*1024))
        resource.setrlimit(resource.RLIMIT_CPU,(12,12))
    except (ImportError,ValueError): pass
    from decimal import getcontext
    getcontext().prec=max(50,getcontext().prec)
    package=WorkbookPackage(content)
    visible=[s for s in package.sheets if s['state']=='visible']
    require(bool(visible),'WORKBOOK_NO_VISIBLE_SHEETS')
    sheet=package.sheet(args['sheet']) if args.get('sheet') else visible[0]
    require(sheet['state']=='visible','PREVIEW_HIDDEN_SHEET')
    start=args.get('start',0)
    require(isinstance(start,int) and not isinstance(start,bool) and 0<=start<=1048575,'PREVIEW_PAGE_INVALID')
    root=package.xml(str(sheet['path']));cells=cell_map(root);evaluator=DecimalEvaluator(root,package.shared_strings)
    positions=[parse_cell(ref) for ref in cells]
    last_row=max((r for c,r in positions),default=0);last_col=max((c for c,r in positions),default=0)
    end=min(last_row,start+100);columns=min(last_col,40);budget=128000
    styles=package.xml('xl/styles.xml') if 'xl/styles.xml' in package.parts else ET.Element(Q('styleSheet'))
    fonts=styles.findall('x:fonts/x:font',NS);fills=styles.findall('x:fills/x:fill',NS);xfs=styles.findall('x:cellXfs/x:xf',NS)
    formats={int(x.attrib['numFmtId']):x.attrib.get('formatCode','') for x in styles.findall('x:numFmts/x:numFmt',NS)}
    date1904=package.workbook_root.find('x:workbookPr',NS)
    epoch=datetime.datetime(1904,1,1) if date1904 is not None and date1904.attrib.get('date1904') in ('1','true') else datetime.datetime(1899,12,30)
    def color(node):
        raw=node.attrib.get('rgb','') if node is not None else ''
        return '#'+raw[-6:] if re.fullmatch('[A-Fa-f0-9]{6,8}',raw) else None
    def cell_style(cell):
        try: xf=xfs[int(cell.attrib.get('s','0'))]
        except (IndexError,ValueError): return {},0,''
        style={};font_id=int(xf.attrib.get('fontId','0'));fill_id=int(xf.attrib.get('fillId','0'))
        if font_id<len(fonts):
            font=fonts[font_id]
            if font.find('x:b',NS) is not None:style['fontWeight']='bold'
            if font.find('x:i',NS) is not None:style['fontStyle']='italic'
            shade=color(font.find('x:color',NS))
            if shade:style['color']=shade
        if fill_id<len(fills):
            fill=fills[fill_id].find('x:patternFill',NS)
            if fill is not None and fill.attrib.get('patternType')=='solid':
                shade=color(fill.find('x:fgColor',NS))
                if shade:style['backgroundColor']=shade
        align=xf.find('x:alignment',NS)
        if align is not None:
            if align.attrib.get('horizontal') in ('left','center','right'):style['textAlign']=align.attrib['horizontal']
            if align.attrib.get('wrapText')=='1':style['whiteSpace']='pre-wrap'
        fmt_id=int(xf.attrib.get('numFmtId','0'));return style,fmt_id,formats.get(fmt_id,'')
    def display_number(value,fmt_id,fmt):
        numeric=Decimal(value)
        if fmt_id in range(14,23) or fmt_id in range(45,48) or (fmt and re.search('[yd]',re.sub(r'"[^"]*"|\[[^\]]*\]','',fmt),re.I)):
            try:return (epoch+datetime.timedelta(days=float(numeric))).isoformat(sep=' ').removesuffix(' 00:00:00')
            except (ValueError,OverflowError):return value
        basic=fmt or {1:'0',2:'0.00',3:'#,##0',4:'#,##0.00',7:'0.00',8:'0.00',9:'0%',10:'0.00%'}.get(fmt_id,'')
        match=re.fullmatch(r'([#0,]+)(?:\.([#0]+))?(%)?',basic)
        if match:
            places=len(match[2] or '')
            if places>12:return value
            amount=numeric*(100 if match[3] else 1)
            amount=amount.quantize(Decimal(1).scaleb(-places),rounding=ROUND_HALF_UP)
            text=format(amount,(',' if ',' in match[1] else '')+'.'+str(places)+'f')
            optional=len(match[2] or '')-len((match[2] or '').rstrip('#'))
            for _ in range(optional):
                if text.endswith('0'):text=text[:-1]
            return text.rstrip('.')+('%' if match[3] else '')

        return value
    merges=[];covered=set();origins={}
    for merge in root.findall('x:mergeCells/x:mergeCell',NS):
        try:c1,r1,c2,r2=parse_range(merge.attrib['ref'])
        except WorkbookError:continue
        if r2<=start or r1>end or c1>columns:continue
        # A merge crossing a page boundary is clipped, with its original value retained.
        rr=max(start+1,r1);cc=c1;origin=cell_reference(c1,r1)
        origins[(cc,rr)]=(min(c2,columns)-cc+1,min(r2,end)-rr+1,origin)
        for r in range(rr,min(r2,end)+1):
            for c in range(cc,min(c2,columns)+1):
                if (c,r)!=(cc,rr):covered.add((c,r))
        merges.append(merge.attrib['ref'])
    import posixpath
    targets={};links={}
    rel_path=posixpath.dirname(str(sheet['path']))+'/_rels/'+posixpath.basename(str(sheet['path']))+'.rels'
    if rel_path in package.parts:
        for rel in package.xml(rel_path):
            if rel.get('TargetMode')=='External':targets[rel.get('Id')]=rel.get('Target')
    for link in root.findall('x:hyperlinks/x:hyperlink',NS):
        url=targets.get(link.get('{'+DOC_REL_NS+'}id'))
        if url:links[link.get('ref')]=url
    rows=[];unsupported=0
    for row in range(start+1,end+1):
        output=[]
        for column in range(1,columns+1):
            if (column,row) in covered:continue
            colspan,rowspan,reference=origins.get((column,row),(1,1,cell_reference(column,row)))
            cell=cells.get(reference);raw=read_cell(cell,package.shared_strings);style,fmt_id,fmt=cell_style(cell) if cell is not None else ({},0,'')
            text='';formula=None;error=None
            if raw['kind']=='formula':
                formula='='+str(raw['formula'])
                try:text=display_number(decimal_text(evaluator.cell(reference)),fmt_id,fmt)
                except (WorkbookError,InvalidOperation) as issue:
                    error=issue.code if isinstance(issue,WorkbookError) else 'FORMULA_CALCULATION_FAILED';text=formula;unsupported+=1
            elif raw['kind']=='number':text=display_number(str(raw['value']),fmt_id,fmt)
            elif raw.get('value') is not None:text=str(raw['value'])
            text=text[:min(2000,max(budget,0))];budget-=len(text)
            output.append({'reference':reference,'column':column,'text':text,'formula':formula,'error':error,'colSpan':colspan,'rowSpan':rowspan,'style':style,'href':links.get(reference)})
        rows.append({'number':row,'cells':output})
    widths=[100]*columns
    for col in root.findall('x:cols/x:col',NS):
        try:
            width=min(400,max(48,float(col.attrib.get('width','13'))*7+5))
            for c in range(max(1,int(col.attrib['min'])),min(columns,int(col.attrib['max']))+1):widths[c-1]=width
        except (ValueError,KeyError):pass
    return {'format':'xlsx','sheet':sheet['name'],'sheets':[s['name'] for s in visible],'rows':rows,'widths':widths,'rowCount':last_row,'columnCount':last_col,'start':start,'nextStart':end if end<last_row else None,'mergedRanges':merges,'unsupportedFormulas':unsupported,'truncatedColumns':last_col>columns,'textTruncated':budget<=0,'formulaPolicy':'fresh-supported-formulas; unsupported formulas displayed explicitly; cached values never used'}
`;
