export const REPORT_PYTHON = String.raw`DS_REASON={'INCLUDED':'纳入统计','SUMMARY_ROW':'合计/小计行，按规则排除','REPEATED_HEADER':'重复表头','DUPLICATE_IDENTICAL':'同编号同内容重复，保留首条','DUPLICATE_CONFLICT':'同编号内容冲突','DUPLICATE_BLOCK':'重复编号，口径不允许自动去重','OTHER_NODE':'不在统计节点','OUTSIDE_PERIOD':'不在统计期间','CANCELLED_RECORD':'已撤销','REQUIRED_MISSING':'必填值缺失','DATE_INVALID':'业务日期无效','UNIT_MISSING':'缺少重量单位','UNIT_INCOMPATIBLE':'单位未获口径允许','WEIGHT_INVALID':'重量无效','NEGATIVE_WEIGHT':'负重量需核实','NODE_UNKNOWN':'业务节点未映射','OBJECT_UNKNOWN':'对象未映射','STATUS_UNKNOWN':'状态未映射','REVERSAL_REQUIRES_REVIEW':'冲销记录待核实','FORMULA_VALUE_UNVERIFIED':'公式无法重新计算'}
def ds_report(data):
 import xlsxwriter,openpyxl,base64
 result=data['result'];summary=result.get('summary')
 if result['status']!='validated' or not summary:ds_fail('DATA_VALIDATION_BLOCKED')
 source=data['source'];policy=data['policy'];mapping=data['mapping'];period=result['period'];total=summary['weightKg']
 metric='产生重量' if policy['definition']['includeNodes']==['产生'] else '所选节点登记重量（非企业总产废量）'
 notes=['统计期间：'+period+'；业务节点：'+ '、'.join(policy['definition']['includeNodes'])+'；采用业务日期（Asia/Shanghai），不使用上传时间。',
  '完整扫描 '+str(result['rowCount'])+' 条数据；纳入 '+str(result['includedCount'])+' 条；排除 '+str(result['excludedCount'])+' 条；异常 '+str(result['invalidCount'])+' 条。',
  '本表按记录逐条换算为 kg，按四舍五入保留 '+str(policy['definition']['precision'])+' 位小数，再求和。同编号处理：'+('同内容保留首条，内容冲突阻断' if policy['definition']['duplicateRule']=='identical_first' else '发现重复即阻断')+'。',
  '月度趋势只表示本次文件中提供的有效记录，不代表完整企业历史。不具备生产量、合同、价格、费用及清运约束，不能推导单位产废、降本或最优清运方案。']
 provenance={'analysisId':data['id'],'resultHash':data['resultHash'],'source':source,'policy':policy,'mapping':mapping}
 sourceRef={'id':'S1','title':source['name'],'version':'快照 '+source['versionId'][:8],'location':mapping['sheet']+'；原始行号见明细表','url':data['sourceUrl'],'quotes':[]}
 payload={'title':period+' 产废月度分析报告','paragraphs':['本期'+metric+' '+total+' kg（'+summary['weightTon']+' 吨），纳入有效产生记录 '+str(result['includedCount'])+' 条。',*notes],
 'table':{'headers':['维度','对象','重量（kg）','占比（%）'],'rows':[[kind,x['name'],x['weightKg'],x['percent'] if x['percent'] is not None else '未知'] for kind,key in [('废物类别','byCategory'),('来源部门/车间','bySource')] for x in summary[key]]},
 'sections':[{'heading':'数据质量与排除说明','paragraphs':[DS_REASON.get(k,k)+'：'+str(v)+' 条' for k,v in result['counts'].items() if k!='INCLUDED'] or ['未发现排除项。']},
 {'heading':'趋势与范围','paragraphs':[x['month']+'：'+x['weightKg']+' kg（仅本文件范围）' for x in summary['trend']]},
 {'heading':'口径与追溯','paragraphs':['口径：'+policy['name']+' v'+str(policy['version'])+'；'+policy['definition']['meaning'],'适用范围：'+policy['definition']['scope'],'映射版本：'+str(mapping['version'])+'；原件及完整追溯信息保存在成果元数据和 Excel「口径与来源」。']}], 'sources':[sourceRef], 'provenance':provenance}
 word=docx(payload)
 output=io.BytesIO();book=xlsxwriter.Workbook(output,{'in_memory':True,'strings_to_formulas':False,'strings_to_urls':False});book.set_properties({'title':period+' 产废分析','comments':data['resultHash']})
 head=book.add_format({'bold':True,'bg_color':'#DBEAFE','border':1,'text_wrap':True});normal=book.add_format({'text_wrap':True,'valign':'top'});number=book.add_format({'num_format':'0.'+'0'*policy['definition']['precision']});link=book.add_format({'font_color':'blue','underline':1});integer=book.add_format({'num_format':'0'});tonnes=book.add_format({'num_format':'0.'+'0'*(policy['definition']['precision']+3)});pct=book.add_format({'num_format':'0.00'})
 def sheet(name,headers,widths):
  w=book.add_worksheet(name);w.freeze_panes(1,0);w.repeat_rows(0);w.set_landscape();w.fit_to_pages(1,0);w.set_paper(9)
  for col,(h,width) in enumerate(zip(headers,widths)):w.write_string(0,col,h,head);w.set_column(col,col,width)
  return w
 def write(w,r,c,v):
  if v is None:w.write_blank(r,c,None,normal)
  else:w.write_string(r,c,str(v)[:32000],normal)
 def finish(w,last,width):
  w.autofilter(0,0,max(1,last),width-1);w.print_area(0,0,max(1,last),width-1)
 detail=sheet('纳入明细',['业务编号','业务日期','业务节点','来源部门/车间','废物类别','原重量','原单位','重量（kg）','原工作表','原行号'],[18,14,12,18,14,16,12,18,22,12]);included=[x for x in result['rows'] if x['outcome']=='included']
 for r,x in enumerate(included,1):
  for c,k in enumerate(['id','date','node','source','category','inputWeight','unit']):write(detail,r,c,x.get(k))
  detail.write_number(r,7,float(Decimal(x['weightKg'])),number);write(detail,r,8,x['sheet']);detail.write_number(r,9,x['row'])
 detail.write_string(len(included)+1,6,'合计',head)
 detail.write_formula(len(included)+1,7,'=SUM(H2:H'+str(len(included)+1)+')' if included else '=0',number,float(Decimal(total)));finish(detail,len(included)+1,10)
 main=sheet('汇总',['指标','数值','单位/说明'],[28,24,80]);main.activate()
 for r,(label,value,unit) in enumerate([('统计期间',period,'业务日期'),('纳入记录数',result['includedCount'],'条'),(metric,float(Decimal(total)),'kg'),(metric+'（吨）',float(Decimal(summary['weightTon'])),'吨'),('扫描记录数',result['rowCount'],'完整扫描'),('排除记录数',result['excludedCount'],'条'),('异常记录数',result['invalidCount'],'条')],1):
  write(main,r,0,label)
  if isinstance(value,(float,int)):main.write_number(r,1,value,integer if isinstance(value,int) else tonnes if unit=='吨' else number)
  else:write(main,r,1,value)
  write(main,r,2,unit)
 for r,note in enumerate(notes,10):write(main,r,0,'计算说明');write(main,r,2,note)
 finish(main,14,3)
 for title,key in [('废物结构','byCategory'),('来源结构','bySource')]:
  w=sheet(title,['对象','重量（kg）','占比（%）'],[28,22,18])
  for r,x in enumerate(summary[key],1):write(w,r,0,x['name']);w.write_number(r,1,float(Decimal(x['weightKg'])),number);w.write_number(r,2,float(x['percent']),pct) if x['percent'] is not None else write(w,r,2,'未知')
  finish(w,len(summary[key]),3)
 w=sheet('月度趋势',['月份','重量（kg）','范围'],[18,24,80])
 for r,x in enumerate(summary['trend'],1):write(w,r,0,x['month']);w.write_number(r,1,float(Decimal(x['weightKg'])),number);write(w,r,2,'仅本文件、指定业务节点和有效记录')
 finish(w,len(summary['trend']),3)
 w=sheet('排除及异常',['原工作表','原行号','业务编号','处理','原因','原始行内容（节选；完整原件见来源）'],[22,12,18,18,38,90]);other=[x for x in result['rows'] if x['outcome']!='included']
 for r,x in enumerate(other,1):
  for c,v in enumerate([x['sheet'],x['row'],x.get('id',''),'阻断' if x['outcome']=='invalid' else '排除',DS_REASON.get(x['reason'],x['reason']),' | '.join(x['original'])]):write(w,r,c,v)
 finish(w,len(other),6)
 w=sheet('口径与来源',['项目','值'],[26,110]);entries=[('来源资料',source['name']),('来源版本',source['versionId']),('来源 SHA256',source['sha256']),('工作表',mapping['sheet']),('表头行',str(mapping['headerRow'])),('映射版本',str(mapping['version'])),('口径',policy['name']),('口径版本',str(policy['version'])),('指标含义',policy['definition']['meaning']),('适用范围',policy['definition']['scope']),('计算结果标识',data['resultHash']),('统计期间',period),('原件链接',data['sourceUrl']),('计算及转换规则',json.dumps(policy['definition'],ensure_ascii=False)),('字段映射',json.dumps(mapping['fields'],ensure_ascii=False))]
 for r,(k,v) in enumerate(entries,1):write(w,r,0,k);w.write_url(r,1,v,link,string='[S1] '+source['name']+' · 固定版本') if k=='原件链接' else write(w,r,1,v)
 finish(w,len(entries),2);book.close();excel=put_provenance(output.getvalue(),provenance)
 # Validate saved bytes, including the cached value supplied from the verified Decimal result.
 loaded=openpyxl.load_workbook(io.BytesIO(excel),read_only=True,data_only=True)
 if Decimal(str(loaded['纳入明细'].cell(len(included)+2,8).value))!=Decimal(total):ds_fail('REPORT_REOPEN_TOTAL_MISMATCH')
 if loaded['纳入明细'].max_row!=len(included)+2:ds_fail('REPORT_REOPEN_COUNT_MISMATCH')
 loaded.close()
 from docx import Document
 if total+' kg' not in '\n'.join(p.text for p in Document(io.BytesIO(word)).paragraphs):ds_fail('REPORT_WORD_TOTAL_MISMATCH')
 return {'docx':base64.b64encode(word).decode(),'xlsx':base64.b64encode(excel).decode(),'validation':{'completeScan':True,'reopened':True,'weightKg':total,'includedCount':len(included),'resultHash':data['resultHash']}}
`;
