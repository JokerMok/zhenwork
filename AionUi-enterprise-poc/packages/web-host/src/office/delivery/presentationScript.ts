/** Bounded native Office layout and provenance helpers; no network or file-system inputs. */
export const OFFICE_PRESENTATION_PYTHON = String.raw`
import math,zipfile,hashlib
from decimal import Decimal,localcontext
from lxml import etree as PX

PROVENANCE_PART='customXml/zhenwork-provenance.xml'

def put_provenance(content,metadata):
    if not metadata:return content
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        parts={i.filename:archive.read(i.filename) for i in archive.infolist()}
    root=PX.Element('{urn:zhenwork:provenance:1}provenance')
    root.text=json.dumps(metadata,ensure_ascii=False,separators=(',',':'))
    parts[PROVENANCE_PART]=PX.tostring(root,encoding='utf-8',xml_declaration=True)
    ct=PX.fromstring(parts['[Content_Types].xml']);ns='http://schemas.openxmlformats.org/package/2006/content-types'
    if not any(n.get('PartName')=='/'+PROVENANCE_PART for n in ct):
        PX.SubElement(ct,'{'+ns+'}Override',PartName='/'+PROVENANCE_PART,ContentType='application/xml')
    parts['[Content_Types].xml']=PX.tostring(ct,encoding='utf-8',xml_declaration=True)
    relns='http://schemas.openxmlformats.org/package/2006/relationships'
    rel_path='word/_rels/document.xml.rels' if 'word/document.xml' in parts else 'xl/_rels/workbook.xml.rels'
    rels=PX.fromstring(parts[rel_path]);target='../'+PROVENANCE_PART
    if not any(n.get('Target')==target for n in rels):
        ids={n.get('Id') for n in rels};rid='rIdZhenworkProvenance'
        while rid in ids:rid+='x'
        PX.SubElement(rels,'{'+relns+'}Relationship',Id=rid,Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml',Target=target)
    parts[rel_path]=PX.tostring(rels,encoding='utf-8',xml_declaration=True)
    out=io.BytesIO()
    with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as archive:
        for name,value in parts.items():archive.writestr(name,value)
    return out.getvalue()

def source_map(data):return {s['id']:s for s in data.get('sources') or []}

def readable_number(value):
    if isinstance(value,Decimal):return format(value.normalize(),'f')
    return text(value)

def report_values(report):
    findings=report['findings'];values={};active=set()
    def value(index):
        if index in values:return values[index]
        if index in active:raise ValueError('CALCULATION_CYCLE')
        active.add(index);metric=findings[index].get('metric') or {};calc=metric.get('calculation')
        if calc:
            refs=calc['rows'];numbers=[value(i-1) for i in refs]
            if any(v is None for v in numbers):raise ValueError('CALCULATION_MISSING_VALUE')
            units=[(findings[i-1].get('metric') or {}).get('unit','') for i in refs]
            if len(set(units))!=1:raise ValueError('CALCULATION_UNIT_MISMATCH')
            with localcontext() as ctx:
                ctx.prec=28
                if calc['operation']=='sum':result=sum(numbers,Decimal(0))
                elif calc['operation']=='difference':result=numbers[0]-numbers[1]
                else:
                    if numbers[1]==0:raise ValueError('CALCULATION_ZERO_DIVISOR')
                    result=numbers[0]/numbers[1]
        else:result=Decimal(str(metric['value'])) if metric.get('value') is not None else None
        values[index]=result;active.remove(index);return result
    for index in range(len(findings)):value(index)
    return values

def common_report_notes(report):
    findings=report['findings'];common={}
    for key in ['analysis','missing']:
        values=[item.get(key,'') for item in findings]
        if len(values)>1 and values[0] and all(value==values[0] for value in values):common[key]=values[0]
    return common

def docx(data):
    from docx import Document
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from docx.opc.constants import RELATIONSHIP_TYPE as RT
    from docx.shared import Pt,Mm
    document=Document();document.core_properties.title=data.get('title') or ''
    section=document.sections[0];section.page_width=Mm(210);section.page_height=Mm(297)
    section.top_margin=Mm(18);section.bottom_margin=Mm(18);section.left_margin=Mm(20);section.right_margin=Mm(20)
    for name,size in [('Normal',10.5),('Title',22),('Heading 1',15),('Heading 2',12)]:
        style=document.styles[name];style.font.name='Microsoft YaHei';style.font.size=Pt(size)
        style._element.get_or_add_rPr().rFonts.set(qn('w:eastAsia'),'Microsoft YaHei')
        style.paragraph_format.space_after=Pt(6);style.paragraph_format.line_spacing=1.2
        if name=='Title':style.font.color.rgb=__import__('docx').shared.RGBColor(0,0,0)
    def paragraph(value,style=None):
        p=document.add_paragraph(text(value),style);p.paragraph_format.widow_control=True;return p
    def heading(value,level=1):
        p=document.add_heading(text(value),level);p.paragraph_format.keep_with_next=True;return p
    def link(p,url,label='打开原文'):
        if not url:return
        element=OxmlElement('w:hyperlink');element.set(qn('r:id'),p.part.relate_to(url,RT.HYPERLINK,is_external=True))
        run=OxmlElement('w:r');props=OxmlElement('w:rPr');style=OxmlElement('w:rStyle');style.set(qn('w:val'),'Hyperlink');props.append(style)
        color=OxmlElement('w:color');color.set(qn('w:val'),'0563C1');props.append(color);underline=OxmlElement('w:u');underline.set(qn('w:val'),'single');props.append(underline);run.append(props)
        txt=OxmlElement('w:t');txt.text=label;run.append(txt);element.append(run);p._p.append(element)
    def table(headers,rows):
        count=max(1,len(headers),max((len(r) for r in rows),default=0));t=document.add_table(rows=0,cols=count);t.style='Table Grid';t.autofit=False
        widths=([70,65,35] if count==3 else [170/count]*count)
        for col,width in zip(t.columns,widths):col.width=Mm(width)
        for index,row in enumerate(([headers] if headers else [])+rows):
            cells=t.add_row().cells
            for col,width in zip(cells,widths):col.width=Mm(width)
            for cell,value in zip(cells,row):
                cell.text=readable_number(value)
                for p in cell.paragraphs:
                    p.paragraph_format.space_after=Pt(3)
                    for run in p.runs:run.font.size=Pt(9);run.font.bold=index==0 and bool(headers)
            if index==0 and headers:
                repeat=OxmlElement('w:tblHeader');t.rows[0]._tr.get_or_add_trPr().append(repeat)
            # Short comparison rows stay together; long prose belongs in paragraphs.
            cant=OxmlElement('w:cantSplit');t.rows[-1]._tr.get_or_add_trPr().append(cant)
        return t
    if data.get('title'):paragraph(data['title'],'Title')
    report=data.get('report');sources=source_map(data)
    if report:
        values=report_values(report)
        heading('结论与范围');paragraph(report['conclusion']);paragraph(report['scope'])
        paragraph('资料中的数值和能力为原文声明。原文可追溯不等于效果经过独立验证；没有独立需求时不作客户符合性承诺。')
        metrics=[]
        for index,item in enumerate(report['findings']):
            metric=item.get('metric')
            if metric:metrics.append([metric['object']+' · '+metric['parameter'],readable_number(values[index])+' '+metric['unit'] if values[index] is not None else '未提供', '['+item['source']+']'])
        if metrics:heading('参数对比');table(['对象与参数','数值与单位','来源'],metrics)
        common=common_report_notes(report)
        if common:
            heading('共同说明')
            for key,label in [('analysis','分析'),('missing','待补资料')]:
                if key in common:paragraph(label+'：'+common[key])
        heading('资料核查');seen=set()
        for index,item in enumerate(report['findings'],1):
            heading(str(index)+' '+item['topic']+' ['+item['source']+']',2)
            if report['purpose']=='compliance':paragraph('核查结论：'+item['assessment'])
            for sid in [item['source'],item.get('requirement')]:
                if sid and sid not in seen:
                    for quote in sources[sid]['quotes']:paragraph('资料原文 ['+sid+']：'+quote)
                    seen.add(sid)
            if item['analysis'] and 'analysis' not in common:paragraph('分析：'+item['analysis'])
            if item['missing'] and 'missing' not in common:paragraph('待补资料：'+item['missing'])
    else:
        for value in data.get('paragraphs') or []:paragraph(value)
        if data.get('table'):table(data['table'].get('headers') or [],data['table'].get('rows') or [])
    for item in data.get('sections') or []:
        heading(item['heading'])
        for value in item['paragraphs']:paragraph(value)
    if sources:
        heading('资料来源')
        for source in sources.values():
            p=paragraph('['+source['id']+'] '+source['title']+' · '+source['version']+' · '+source['location']+'  ');link(p,source.get('url'),'读取快照' if source.get('originalUrl') else '打开原文')
            if source.get('originalUrl'):link(p,source['originalUrl'],' 原网页')
            if not report:
                for quote in source['quotes']:paragraph('原文：'+quote)
    if not document.paragraphs:paragraph('')
    output=io.BytesIO();document.save(output);return put_provenance(output.getvalue(),data.get('provenance'))

def xlsx(data):
    from openpyxl import Workbook
    from openpyxl.styles import Alignment,Font,PatternFill
    from openpyxl.utils import get_column_letter
    wb=Workbook();wb.remove(wb.active);wb.properties.title=data.get('title') or ''
    def scalar(cell,value):
        cell.value=value
        if isinstance(value,str):cell.data_type='s'
    def sheet(name,headers,rows,widths,intro=None):
        ws=wb.create_sheet(name[:31]);row=1;columns=max(1,len(headers),max((len(r) for r in rows),default=0))
        for line in intro or []:
            scalar(ws.cell(row,1),line)
            if columns>1:ws.merge_cells(start_row=row,start_column=1,end_row=row,end_column=columns)
            ws.row_dimensions[row].height=max(24,math.ceil(len(line)/max(30,sum(widths)/2))*16);row+=1
        header=row
        if headers:
            for col,value in enumerate(headers,1):
                c=ws.cell(row,col);scalar(c,value);c.font=Font(name='Microsoft YaHei',bold=True,color='FFFFFF');c.fill=PatternFill('solid',fgColor='244B68')
            row+=1
        for values in rows:
            max_lines=1
            for col,value in enumerate(values,1):
                c=ws.cell(row,col);scalar(c,float(value) if isinstance(value,Decimal) else value)
                max_lines=max(max_lines,sum(max(1,math.ceil(len(s)*1.6/max(8,widths[min(col-1,len(widths)-1)]))) for s in text(value).splitlines()) if value is not None else 1)
                if isinstance(value,(int,float,Decimal)):c.number_format='0.########'
            ws.row_dimensions[row].height=min(300,max(25,max_lines*15+5));row+=1
        for line in ws:
            for c in line:
                if c.row!=header:c.font=Font(name='Microsoft YaHei',size=10)
                c.alignment=Alignment(vertical='top',wrap_text=True)
        for col,width in enumerate(widths,1):ws.column_dimensions[get_column_letter(col)].width=width
        ws.freeze_panes='A'+str(header+1);ws.auto_filter.ref='A'+str(header)+':'+get_column_letter(columns)+str(max(header,row-1))
        ws.print_title_rows=str(header)+':'+str(header);ws.print_area='A1:'+get_column_letter(columns)+str(max(1,row-1))
        ws.page_setup.orientation='landscape' if columns>5 else 'portrait';ws.page_setup.paperSize=ws.PAPERSIZE_A4;ws.page_setup.fitToWidth=1;ws.page_setup.fitToHeight=0;ws.sheet_properties.pageSetUpPr.fitToPage=True
        ws.sheet_view.showGridLines=False
        return ws,header+1
    report=data.get('report');sources=source_map(data);formula_requests=[]
    if report:
        resolved=report_values(report);rows=[];notes=[];evidence=[];common=common_report_notes(report)
        for key,label in [('analysis','分析'),('missing','待补资料')]:
            if key in common:
                for offset in range(0,len(common[key]),220):notes.append(['全部','共同说明',label,common[key][offset:offset+220]])
        for index,item in enumerate(report['findings']):
            m=item.get('metric') or {};analysis=item['analysis'];missing=item['missing']
            rows.append([index+1,m.get('object',''),m.get('parameter') or item['topic'],resolved[index] if m else item['assessment'],m.get('unit',''),item['source']])
            for kind,key,value in [('分析','analysis',analysis),('待补资料','missing',missing)]:
                if key in common:continue
                for start in range(0,len(value),220):notes.append([index+1,item['topic'],kind,value[start:start+220]])
            if m.get('calculation'):formula_requests.append((index,m['calculation']))
        main,start=sheet('参数对比',['序号','对象','参数或主题','数值或状态','单位','来源'],rows,[7,24,34,23,16,10],[data.get('title') or '',report['scope']])
        for index,calc in formula_requests:
            refs=['D'+str(start+i-1) for i in calc['rows']]
            formula='SUM('+','.join(refs)+')' if calc['operation']=='sum' else refs[0]+('-' if calc['operation']=='difference' else '/')+refs[1]
            main.cell(start+index,4,'='+formula)
        sheet('分析与缺项',['序号','主题','类别','说明'],notes,[8,30,16,85],['资料数值为原文声明，不等于独立实测或客户符合。',report['conclusion']])
    else:
        definitions=data.get('sheets') or [dict(data.get('table') or {'headers':[],'rows':[]},name='内容')]
        used=set()
        for index,item in enumerate(definitions):
            base=''.join('_' if c in '[]:*?/\\' else c for c in item.get('name') or '内容')[:27];name=base;counter=2
            while name in used or name in ['资料来源','证据摘录']:name=base+'_'+str(counter);counter+=1
            used.add(name);headers=item.get('headers') or [];rows=item.get('rows') or [];columns=max(1,len(headers),max((len(r) for r in rows),default=0));widths=[min(44,max(14,max((len(text(r[c])) for r in rows if c<len(r)),default=0)+2)) for c in range(columns)]
            sheet(name,headers,rows,widths,[data.get('title') or '',*(data.get('paragraphs') or [])] if index==0 else None)
    if sources:
        source_rows=[];quotes=[]
        for s in sources.values():
            source_rows.append([s['id'],s['title'],s['version'],s['location'],('读取快照' if s.get('originalUrl') else '打开原文') if s.get('url') else '无在线原文地址','原网页' if s.get('originalUrl') else ''])
            for q in s['quotes']:
                for offset in range(0,len(q),220):quotes.append([s['id'],s['location'],q[offset:offset+220],'打开原文' if s.get('url') else ''])
        refs,start=sheet('资料来源',['来源','资料名称','版本','位置','链接','原网页'],source_rows,[10,48,22,28,18,18])
        for row,s in enumerate(sources.values(),start):
            if s.get('url'):refs.cell(row,5).hyperlink=s['url'];refs.cell(row,5).style='Hyperlink'
            if s.get('originalUrl'):refs.cell(row,6).hyperlink=s['originalUrl'];refs.cell(row,6).style='Hyperlink'
        qs,start=sheet('证据摘录',['来源','位置','原文摘录','链接'],quotes,[10,25,90,18])
        for row,q in enumerate(quotes,start):
            if sources[q[0]].get('url'):qs.cell(row,4).hyperlink=sources[q[0]]['url'];qs.cell(row,4).style='Hyperlink'
    if not wb.worksheets:sheet('内容',[],[],[20])
    output=io.BytesIO();wb.save(output);content=output.getvalue()
    if formula_requests:content=recalculate_office_formulas(content)
    return put_provenance(content,data.get('provenance'))

def recalculate_office_formulas(content):
    package=WorkbookPackage(content)
    for item in package.sheets:
        root=package.xml(str(item['path']));calculator=DecimalEvaluator(root,package.shared_strings)
        for cell in root.iter(Q('c')):
            if cell.find(Q('f')) is not None:
                value=calculator.cell(cell.attrib['r']);cached=cell.find(Q('v'))
                if cached is None:cached=ET.SubElement(cell,Q('v'))
                cached.text=decimal_text(value);cell.attrib.pop('t',None)
        package.parts[str(item['path'])]=ET.tostring(root,encoding='utf-8',xml_declaration=True)
    out=io.BytesIO()
    with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as archive:
        for name,value in package.parts.items():archive.writestr(name,value)
    return out.getvalue()
`;
