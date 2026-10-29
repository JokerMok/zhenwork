/** PPT edits target real slide/shape IDs; isolated text/style edits preserve unrelated ZIP parts. */
export const PPT_REVISION_PYTHON = String.raw`
def ppt_zip(parts):
    out=io.BytesIO()
    with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:
        for name,value in parts.items():z.writestr(name,value)
    return out.getvalue()
def ppt_replace_text(node,expected,value):
    paragraphs=node.findall('.//a:p',PPT_NS)
    actual='\n'.join(''.join(t.text or '' for t in p.findall('.//a:t',PPT_NS)) for p in paragraphs)
    if actual!=expected:raise ValueError('PPT_TEXT_CHANGED_READ_CURRENT_OBJECT')
    if not paragraphs:raise ValueError('PPT_TEXT_OBJECT_EMPTY')
    from copy import deepcopy
    first=paragraphs[0];parent=first.getparent();position=list(parent).index(first);props=first.find('a:pPr',PPT_NS);runprops=first.find('a:r/a:rPr',PPT_NS)
    for p in paragraphs:parent.remove(p)
    for index,line in enumerate(value.split('\n')):
        paragraph=PX.Element('{'+PPT_NS['a']+'}p')
        if props is not None:paragraph.append(deepcopy(props))
        run=PX.SubElement(paragraph,'{'+PPT_NS['a']+'}r')
        if runprops is not None:run.append(deepcopy(runprops))
        text=PX.SubElement(run,'{'+PPT_NS['a']+'}t');text.set('{http://www.w3.org/XML/1998/namespace}space','preserve');text.text=line
        parent.insert(position+index,paragraph)

def ppt_revise(content,operations,trusted=None):
    before=ppt_inspect(content);parts=ppt_package(content);metadata=before.get('provenance');changes=[]
    business=(metadata or {}).get('businessResult');structural=False
    for op in operations:
        kind=op['kind'];prs=Presentation(io.BytesIO(ppt_zip(parts)));at=op.get('slide',1)-1
        if at<0 or at>=len(prs.slides):raise ValueError('PPT_SLIDE_OUT_OF_RANGE')
        slide=prs.slides[at];part=str(slide.part.partname).lstrip('/');root=PX.fromstring(parts[part])
        if kind in ['set_slide_title','set_slide_text']:
            candidates=[]
            for shape in root.findall('.//p:sp',PPT_NS):
                prop=shape.find('p:nvSpPr/p:cNvPr',PPT_NS)
                if prop is not None and ((kind=='set_slide_title' and prop.get('name')=='zw:title') or (kind=='set_slide_text' and int(prop.get('id'))==op['shapeId'])):candidates.append(shape)
            if len(candidates)!=1:raise ValueError('PPT_INSPECT_EXACT_TEXT_OBJECT_REQUIRED')
            node=candidates[0];name=node.find('p:nvSpPr/p:cNvPr',PPT_NS).get('name','')
            if name.startswith(('zw:metric','zw:fact','zw:source','zw:page')) or (business and name not in ['zw:title','zw:body','zw:subtitle','zw:caption']):raise ValueError('PPT_BUSINESS_FACT_READ_ONLY_REGENERATE_RESULT')
            value=op.get('title') if kind=='set_slide_title' else op['text'];ppt_replace_text(node,op['expectedText'],value)
            shape=next(s for s in slide.shapes if s.shape_id==int(node.find('p:nvSpPr/p:cNvPr',PPT_NS).get('id')))
            points=next((r.font.size.pt for p in shape.text_frame.paragraphs for r in p.runs if r.font.size),20)
            if sum(max(1,math.ceil(ppt_text_units(s)/(shape.width/914400*72/(points*.52)))) for s in value.split('\n'))*points*1.4>shape.height/914400*72:raise ValueError('PPT_TEXT_OVERFLOW')
            parts[part]=PX.tostring(root,encoding='utf-8',xml_declaration=True)
            changes.append({'kind':kind,'slide':at+1,'shapeId':shape.shape_id,'before':op['expectedText'],'after':value})
        elif kind=='set_chart_style':
            shape=next((s for s in slide.shapes if s.shape_id==op['shapeId'] and s.has_chart),None)
            if shape is None:raise ValueError('PPT_CHART_OBJECT_REQUIRED')
            name=str(shape.chart.part.partname).lstrip('/');chart=PX.fromstring(parts[name]);ns=PPT_NS['c']
            if 'title' in op:
                title=chart.find('c:chart/c:title',PPT_NS)
                if title is None:raise ValueError('PPT_CHART_TITLE_REQUIRED')
                old='\n'.join(''.join(t.text or '' for t in p.findall('.//a:t',PPT_NS)) for p in title.findall('.//a:p',PPT_NS))
                ppt_replace_text(title,op.get('expectedText',old),op['title'])
            if 'style' in op:
                style=chart.find('c:style',PPT_NS)
                if style is None:style=PX.Element('{'+ns+'}style');chart.insert(0,style)
                style.set('val',str(op['style']))
            if 'showLegend' in op:
                parent=chart.find('c:chart',PPT_NS);legend=parent.find('c:legend',PPT_NS)
                if legend is not None and not op['showLegend']:parent.remove(legend)
                elif legend is None and op['showLegend']:
                    legend=PX.SubElement(parent,'{'+ns+'}legend');PX.SubElement(legend,'{'+ns+'}legendPos',val='b')
            parts[name]=PX.tostring(chart,encoding='utf-8',xml_declaration=True);changes.append({'kind':kind,'slide':at+1,'shapeId':shape.shape_id})
        elif kind=='update_chart':
            if not business or not trusted or op['resultId']!=business['id'] or trusted.get('id')!=business['id']:raise ValueError('PPT_DATA_CHANGE_REGENERATE_FROM_NEW_VERIFIED_RESULT')
            chart_data=next((s['chart'] for s in trusted['slides'] if s.get('chart',{}).get('dataKey')==op['dataKey']),None)
            shape=next((s for s in slide.shapes if s.shape_id==op['shapeId'] and s.has_chart),None)
            if not chart_data or shape is None or shape.name!='zw:chart:'+op['dataKey']:raise ValueError('PPT_TRUSTED_CHART_KEY_MISMATCH')
            cd=CategoryChartData(number_format=chart_data.get('numberFormat','0.###'));cd.categories=chart_data['categories']
            for s in chart_data['series']:cd.add_series(s['name'],[Decimal(v) for v in s['values']])
            shape.chart.replace_data(cd);out=io.BytesIO();prs.save(out);parts=ppt_package(out.getvalue());changes.append({'kind':kind,'slide':at+1,'shapeId':shape.shape_id,'resultId':op['resultId'],'dataKey':op['dataKey']})
        elif kind in ['insert_slide','delete_slide','move_slide']:
            ids=prs.slides._sldIdLst
            if kind=='insert_slide':
                if len(prs.slides)>=30:raise ValueError('PPT_SLIDE_LIMIT_30')
                if op['position']>len(prs.slides)+1:raise ValueError('PPT_DESTINATION_OUT_OF_RANGE')
                item=op['content'];ppt_add_slide(prs,item,{},len(prs.slides)+1,len(prs.slides)+1,{})
                node=ids[-1];ids.remove(node);ids.insert(op['position']-1,node)
            elif kind=='delete_slide':
                if len(prs.slides)<=1:raise ValueError('PPT_LAST_SLIDE_CANNOT_DELETE')
                if business and any(s.name.startswith(('zw:metric','zw:fact','zw:chart','zw:table','zw:source-link')) for s in slide.shapes):raise ValueError('PPT_REQUIRED_FACT_OR_SOURCE_SLIDE_CANNOT_DELETE')
                node=ids[at];prs.part.drop_rel(node.rId);ids.remove(node)
            else:
                to=op['destination']-1
                if to<0 or to>=len(prs.slides):raise ValueError('PPT_DESTINATION_OUT_OF_RANGE')
                node=ids[at];ids.remove(node);ids.insert(to,node)
            for n,s in enumerate(prs.slides,1):
                for shape in s.shapes:
                    if shape.name=='zw:page':shape.text_frame.paragraphs[0].runs[0].text=str(n)+' / '+str(len(prs.slides))
            out=io.BytesIO();prs.save(out);parts=ppt_package(out.getvalue());structural=True;changes.append({'kind':kind,'slide':at+1,'position':op.get('position'),'destination':op.get('destination')})
        else:raise ValueError('OPERATION_NOT_FOR_PPTX')
    output=ppt_zip(parts)
    if metadata:
        metadata.setdefault('revisions',[]).append({'previousSha256':hashlib.sha256(content).hexdigest(),'changes':changes,'sourceFactsReverified':False})
        if len(metadata['revisions'])>40:raise ValueError('PPT_REVISION_METADATA_LIMIT')
        output=put_provenance(output,metadata)
    after=ppt_inspect(output)
    if business and trusted:
        expected={s['chart']['dataKey']:s['chart'] for s in trusted['slides'] if s.get('chart',{}).get('dataKey')}
        for s in after['slides']:
            for c in s['objects']:
                if c['kind']=='chart' and c['dataKey'] in expected:
                    e=expected[c['dataKey']]
                    if c['categories']!=e['categories'] or [[Decimal(v) for v in x['values']] for x in c['series']]!=[[Decimal(v) for v in x['values']] for x in e['series']]:raise ValueError('PPT_CHART_RESULT_MISMATCH')
    return output,{'before':before,'after':after,'changes':changes,'businessDataMatched':bool(business and trusted),'sourceFactsReverified':False,'unrequestedPartsPreserved':True,'structuralChange':structural}
`;
