/** Extends the existing python-pptx generator; only in-memory, bounded assets are accepted. */
export const NATIVE_PRESENTATION_PYTHON = String.raw`
import base64,re,unicodedata,posixpath
from pptx import Presentation
from pptx.util import Inches,Pt
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.chart import XL_CHART_TYPE,XL_LABEL_POSITION,XL_LEGEND_POSITION
from pptx.chart.data import CategoryChartData

PPT_NS={'a':'http://schemas.openxmlformats.org/drawingml/2006/main','p':'http://schemas.openxmlformats.org/presentationml/2006/main','c':'http://schemas.openxmlformats.org/drawingml/2006/chart','r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
def ppt_package(content,template=False):
    if len(content)>10*1024*1024:raise ValueError('PPT_INPUT_LIMIT_10MB')
    with zipfile.ZipFile(io.BytesIO(content)) as z:
        infos=z.infolist()
        if len(infos)>4000 or len({x.filename for x in infos})!=len(infos) or sum(x.file_size for x in infos)>80*1024*1024:raise ValueError('PPT_EXPANSION_LIMIT')
        parts={}
        for info in infos:
            name=info.filename
            if name.startswith('/') or '..' in name.split('/') or '\\' in name or info.flag_bits&1:raise ValueError('PPT_PACKAGE_PATH_INVALID')
            if any(s in name.lower() for s in ['vbaproject','activex','oleobject','/embeddings/']) and (template or not name.lower().endswith('.xlsx')):raise ValueError('PPT_ACTIVE_CONTENT_REJECTED')
            if info.file_size>20*1024*1024:raise ValueError('PPT_PART_LIMIT')
            value=z.read(info)
            if '/embeddings/' in name.lower() and name.lower().endswith('.xlsx'):
                with zipfile.ZipFile(io.BytesIO(value)) as book:
                    nested=book.infolist()
                    if len(nested)>200 or sum(x.file_size for x in nested)>10*1024*1024:raise ValueError('PPT_CHART_WORKBOOK_LIMIT')
                    for child in nested:
                        if any(x in child.filename.lower() for x in ['vba','external','connections','querytable']):raise ValueError('PPT_CHART_EXTERNAL_DATA_REJECTED')
                        if child.filename.endswith(('.xml','.rels')):
                            raw=book.read(child)
                            if b'<!DOCTYPE' in raw.upper() or b'<!ENTITY' in raw.upper():raise ValueError('PPT_XML_ENTITY_REJECTED')
                            tree=PX.fromstring(raw,parser=PX.XMLParser(resolve_entities=False,no_network=True))
                            if any(x.get('TargetMode')=='External' or str(x.tag).endswith('}f') for x in tree.iter()):raise ValueError('PPT_CHART_EXTERNAL_DATA_REJECTED')
            if name.endswith(('.xml','.rels')):
                if b'<!DOCTYPE' in value.upper() or b'<!ENTITY' in value.upper():raise ValueError('PPT_XML_ENTITY_REJECTED')
                root=PX.fromstring(value,parser=PX.XMLParser(resolve_entities=False,no_network=True))
                if any('macro' in x.get('action','').lower() for x in root.iter()):raise ValueError('PPT_ACTIVE_CONTENT_REJECTED')
                if name.endswith('.rels'):
                    for rel in root:
                        target=rel.get('Target','');kind=rel.get('Type','')
                        if rel.get('TargetMode')=='External':
                            if template or not kind.endswith('/hyperlink') or not target.startswith('https://'):raise ValueError('PPT_EXTERNAL_RESOURCE_REJECTED')
                        elif target.startswith(('/', '\\')) or re.match(r'^[a-zA-Z]+:',target):raise ValueError('PPT_RELATIONSHIP_INVALID')
            parts[name]=value
        if 'ppt/presentation.xml' not in parts:raise ValueError('PPT_PRESENTATION_REQUIRED')
        return parts

def ppt_image(value):
    from PIL import Image
    raw=base64.b64decode(value,validate=True)
    if len(raw)>1024*1024:raise ValueError('PPT_IMAGE_LIMIT_1MB')
    with Image.open(io.BytesIO(raw)) as image:
        if image.format not in ['PNG','JPEG'] or image.width*image.height>12000000:raise ValueError('PPT_IMAGE_INVALID')
        image.load();out=io.BytesIO();image.convert('RGBA').save(out,format='PNG');return out.getvalue()

def ppt_picture(slide,value,x,y,w,h,name):
    from PIL import Image
    raw=ppt_image(value)
    with Image.open(io.BytesIO(raw)) as image:
        scale=min(w/image.width,h/image.height);width=image.width*scale;height=image.height*scale
    picture=slide.shapes.add_picture(io.BytesIO(raw),Inches(x+(w-width)/2),Inches(y+(h-height)/2),width=Inches(width),height=Inches(height));picture.name=name;return picture

def ppt_text_units(value):return sum(2 if unicodedata.east_asian_width(c) in ['F','W'] else 1 for c in value)
def ppt_text(slide,name,value,x,y,w,h,size,font,color,bold=False,minimum=16,link=None):
    box=slide.shapes.add_textbox(Inches(x),Inches(y),Inches(w),Inches(h));box.name=name
    tf=box.text_frame;tf.clear();tf.word_wrap=True
    lines=lambda pt:sum(max(1,math.ceil(ppt_text_units(s)/max(1,w*72/(pt*.52)))) for s in value.split('\n'))
    while size>minimum and lines(size)*size*1.4>h*72-8:size-=1
    if lines(size)*size*1.4>h*72:raise ValueError('PPT_TEXT_OVERFLOW')
    for i,line in enumerate(value.split('\n')):
        p=tf.paragraphs[0] if i==0 else tf.add_paragraph();p.text=line;p.space_after=Pt(5)
        for run in p.runs:
            run.font.name=font;run.font.size=Pt(size);run.font.bold=bold;run.font.color.rgb=RGBColor.from_string(color)
            if link:run.hyperlink.address=link
    return box

def ppt_add_slide(prs,item,theme,page,total,sources):
    blank=next((x for x in prs.slide_layouts if x.name.lower()=='blank'),prs.slide_layouts[-1]);slide=prs.slides.add_slide(blank)
    for shape in list(slide.placeholders):shape._element.getparent().remove(shape._element)
    primary=theme.get('primary','19384D');accent=theme.get('accent','087F8C');font=theme.get('font','Noto Sans CJK SC');layout=item.get('layout','content')
    band=slide.shapes.add_shape(MSO_SHAPE.RECTANGLE,0,0,prs.slide_width,Inches(.1));band.name='zw:decoration';band.fill.solid();band.fill.fore_color.rgb=RGBColor.from_string(accent);band.line.fill.background()
    cover=layout in ['cover','section'];tx=.75;ty=2.0 if cover else .4;tw=11.7 if not theme.get('logo') else 10.4
    ppt_text(slide,'zw:title',item.get('title',''),tx,ty,tw,1.35 if cover else 1.0,36 if cover else theme.get('titleSize',30),font,primary,True,24)
    if item.get('subtitle'):ppt_text(slide,'zw:subtitle',item['subtitle'],.8,3.6 if cover else 1.3,11.7,.8,22,font,accent,minimum=16)
    if theme.get('logo'):
        ppt_picture(slide,theme['logo'],11.75,.32,.75,.6,'zw:logo')
    y=1.7
    if item.get('metrics'):
        metrics=item['metrics'];width=11.75/len(metrics)
        for i,m in enumerate(metrics):
            x=.8+i*width
            card=slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE,Inches(x),Inches(y),Inches(width-.18),Inches(1.5));card.name='zw:metric-card';card.fill.solid();card.fill.fore_color.rgb=RGBColor(241,246,248);card.line.fill.background()
            ppt_text(slide,'zw:metric-label',m['label'],x+.16,y+.12,width-.5,.35,17,font,primary,minimum=16)
            ppt_text(slide,'zw:metric-value',m['value']+' '+m.get('unit',''),x+.16,y+.62,width-.5,.65,28,font,accent,True,20)
        y+=1.85
    if item.get('chart'):
        c=item['chart'];cd=CategoryChartData(number_format=c.get('numberFormat','0.###'));cd.categories=c['categories']
        for s in c['series']:
            values=[Decimal(v) for v in s['values']]
            if any(len(v.as_tuple().digits)>15 or not v.is_finite() for v in values):raise ValueError('PPT_CHART_PRECISION_UNREPRESENTABLE')
            cd.add_series(s['name'],values,number_format=c.get('numberFormat','0.###'))
        chart=slide.shapes.add_chart({'column':XL_CHART_TYPE.COLUMN_CLUSTERED,'line':XL_CHART_TYPE.LINE_MARKERS,'pie':XL_CHART_TYPE.PIE}[c['type']],Inches(.9),Inches(1.65),Inches(11.5),Inches(4.9),cd).chart
        shape=slide.shapes[-1];shape.name='zw:chart:'+c.get('dataKey','display')
        chart.has_title=True;chart.chart_title.text_frame.text=c['title']
        for run in chart.chart_title.text_frame.paragraphs[0].runs:run.font.name=font;run.font.size=Pt(20);run.font.color.rgb=RGBColor.from_string(primary)
        chart.has_legend=c['type']=='pie' or len(c['series'])>1
        if chart.has_legend:chart.legend.position=XL_LEGEND_POSITION.BOTTOM;chart.legend.font.name=font;chart.legend.font.size=Pt(14)
        plot=chart.plots[0];plot.has_data_labels=True;labels=plot.data_labels;labels.show_value=True;labels.font.name=font;labels.font.size=Pt(14);labels.number_format=c.get('numberFormat','0.###')
        if c['type']=='pie':labels.show_category_name=True
        else:
            chart.category_axis.tick_labels.font.name=font;chart.category_axis.tick_labels.font.size=Pt(14);chart.value_axis.tick_labels.font.size=Pt(13);chart.value_axis.tick_labels.number_format=c.get('numberFormat','0.###')
        palette=[accent,primary,'D28B3D','738C9C']
        for i,s in enumerate(chart.series):
            if c['type']!='pie':s.format.fill.solid();s.format.fill.fore_color.rgb=RGBColor.from_string(palette[i%len(palette)])
        y=6.65
    if item.get('table'):
        data=item['table'];headers=data['headers'];rows=data['rows'];count=len(rows)+1;height=min(4.7,count*.57)
        table=slide.shapes.add_table(count,len(headers),Inches(.8),Inches(y),Inches(11.75),Inches(height));table.name='zw:table';t=table.table
        for r,values in enumerate([headers]+rows):
            for col,value in enumerate(values):
                cell=t.cell(r,col);cell.text='' if value is None else str(value);cell.margin_left=Inches(.09);cell.margin_right=Inches(.09)
                if r==0:cell.fill.solid();cell.fill.fore_color.rgb=RGBColor.from_string(primary)
                width=11.75/len(headers);row_height=height/count;units=ppt_text_units(cell.text);size=18
                while size>14 and max(1,math.ceil(units/(width*72/(size*.52))))*size*1.25>row_height*72-6:size-=1
                if max(1,math.ceil(units/(width*72/(size*.52))))*size*1.25>row_height*72:raise ValueError('PPT_TABLE_OVERFLOW')
                for p in cell.text_frame.paragraphs:
                    for run in p.runs:run.font.name=font;run.font.size=Pt(size);run.font.bold=r==0;run.font.color.rgb=RGBColor(255,255,255) if r==0 else RGBColor.from_string(primary)
        y+=height+.2
    entries=[*item.get('paragraphs',[]),*['• '+s for s in item.get('bullets',[])]]
    if entries:
        value='\n\n'.join(entries);height=6.65-y
        box=ppt_text(slide,'zw:fact-body' if item.get('protected') else 'zw:body',value,.85,y,11.6,height,theme.get('bodySize',20),font,primary,minimum=16)
        for paragraph in box.text_frame.paragraphs:
            if paragraph.text.startswith('• '):
                paragraph.runs[0].text=paragraph.runs[0].text[2:];props=paragraph._p.get_or_add_pPr();props.set('marL',str(Pt(16)));props.set('indent',str(-Pt(12)))
                for node in list(props):
                    if str(node.tag).endswith(('}buNone','}buChar')):props.remove(node)
                PX.SubElement(props,'{'+PPT_NS['a']+'}buChar',char='•')
    if item.get('images'):
        for i,p in enumerate(item['images']):
            ppt_picture(slide,p['content'],.9+i*6,1.7,5.5,4.3,'zw:image')
            if p.get('caption'):ppt_text(slide,'zw:caption',p['caption'],.9+i*6,6.05,5.5,.5,16,font,primary,minimum=14)
    ids=item.get('sourceIds',[]);footer='  '.join('['+s+']' for s in ids[:8])+(' · 其余见来源页' if len(ids)>8 else '')
    ppt_text(slide,'zw:source',footer,.8,7.0,10.3,.27,11,font,'5E7180',minimum=9)
    ppt_text(slide,'zw:page',str(page)+' / '+str(total),11.6,7.0,.85,.27,11,font,'5E7180',minimum=9)
    notes=item.get('notes','')
    links=[sources[s] for s in ids if s in sources and (sources[s].get('url') or sources[s].get('originalUrl'))]
    if layout=='sources':
        for i,source in enumerate(links[:4]):
            ppt_text(slide,'zw:source-link','['+source['id']+'] 打开原文',.85,6.1+i*.17,10.8,.2,11,font,accent,minimum=9,link=source.get('url') or source.get('originalUrl'))
    slide.notes_slide.notes_text_frame.text=(notes+'\n'+ '\n'.join('['+s['id']+'] '+s['title']+' · '+s['version']+' · '+s['location']+'\n'+(s.get('url') or s.get('originalUrl') or '') for s in links))[:30000]
    return slide

def pptx(data):
    theme=data.get('presentationTheme') or {};template=theme.get('template')
    if template:
        template=base64.b64decode(template,validate=True);ppt_package(template,True);prs=Presentation(io.BytesIO(template))
        if abs(prs.slide_width/prs.slide_height-16/9)>.02:raise ValueError('PPT_TEMPLATE_16_9_REQUIRED')
        for sid in list(prs.slides._sldIdLst):prs.part.drop_rel(sid.rId);prs.slides._sldIdLst.remove(sid)
    else:prs=Presentation()
    prs.slide_width=Inches(13.333333);prs.slide_height=Inches(7.5);prs.core_properties.title=data.get('title') or ''
    slides=data.get('slides') or [{'title':data.get('title') or '', 'paragraphs':data.get('paragraphs') or []}]
    # Legacy free-form calls keep their cover behavior; business slides explicitly supply their cover.
    if data.get('title') and slides[0].get('layout')!='cover' and data.get('slides'):slides=[{'title':data['title'],'layout':'cover'}]+slides
    if not 1<=len(slides)<=30:raise ValueError('PPT_SLIDE_LIMIT_30')
    for index,item in enumerate(slides,1):ppt_add_slide(prs,item,theme,index,len(slides),source_map(data))
    out=io.BytesIO();prs.save(out);content=put_provenance(out.getvalue(),data.get('provenance'));ppt_inspect(content);return content

def ppt_inspect(content):
    parts=ppt_package(content);prs=Presentation(io.BytesIO(content))
    if not 1<=len(prs.slides)<=30:raise ValueError('PPT_SLIDE_LIMIT_30')
    slides=[];issues=[]
    for index,slide in enumerate(prs.slides,1):
        items=[]
        for shape in slide.shapes:
            item={'id':shape.shape_id,'name':shape.name,'kind':'shape','bounds':[shape.left,shape.top,shape.width,shape.height]}
            if shape.left<0 or shape.top<0 or shape.left+shape.width>prs.slide_width+1000 or shape.top+shape.height>prs.slide_height+1000:issues.append({'slide':index,'shape':shape.shape_id,'code':'OUTSIDE_SLIDE'})
            if shape.has_text_frame:item.update({'kind':'text','text':shape.text})
            if shape.has_table:item.update({'kind':'table','rows':[[c.text for c in row.cells] for row in shape.table.rows]})
            if shape.has_chart:
                c=shape.chart;item.update({'kind':'chart','title':c.chart_title.text_frame.text if c.has_title else '', 'chartType':str(c.chart_type),'categories':[x.label for x in c.plots[0].categories], 'series':[{'name':s.name,'values':[str(v) for v in s.values]} for s in c.series],'dataKey':shape.name.removeprefix('zw:chart:')})
                if not any('externalData' in str(x.tag) for x in c._chartSpace.iter()):raise ValueError('PPT_CHART_WORKBOOK_MISSING')
            items.append(item)
        slides.append({'slide':index,'title':next((x.get('text','') for x in items if x['name']=='zw:title'),''),'objects':items,'notes':slide.notes_slide.notes_text_frame.text if slide.has_notes_slide else ''})
    metadata=None
    if PROVENANCE_PART in parts:metadata=json.loads(PX.fromstring(parts[PROVENANCE_PART]).text)
    if issues:raise ValueError('PPT_LAYOUT_OUTSIDE_SLIDE')
    return {'format':'pptx','slides':slides,'slideCount':len(slides),'nativeCharts':sum(x['kind']=='chart' for s in slides for x in s['objects']),'nativeTables':sum(x['kind']=='table' for s in slides for x in s['objects']),'editableTextShapes':sum(x['kind']=='text' for s in slides for x in s['objects']),'layoutIssues':issues,'provenance':metadata}
`;
