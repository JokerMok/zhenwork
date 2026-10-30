"""Portable, deterministic industry methods. stdin JSON -> stdout JSON. No file/network I/O.
Workbook loading is supplied by ZhenWork's existing bounded ds_load adapter.
"""
import sys,json,base64,datetime as dt,collections,re
from decimal import Decimal,InvalidOperation,ROUND_HALF_UP
D=Decimal

def run(payload):
 cfg=payload['company']; prefs=payload['preferences']; methods=payload.get('methods') or prefs['methods']
 if not methods or any(x not in ['ledger','inventory','transfer','settlement','checklist'] for x in methods):raise ValueError('METHOD_UNKNOWN')
 raw=base64.b64decode(payload['input'],validate=True); name=payload['name']; issues=[]
 def issue(kind,code,ref,detail):issues.append({'kind':kind,'code':code,'source':ref,'detail':detail})
 if name.lower().endswith('.json'):
  data=json.loads(raw); data=data.get('tables',data)
  if not isinstance(data,dict):raise ValueError('TABLE_OBJECT_REQUIRED')
  tables={k:[dict(r,_source=r.get('_source',k+':'+str(i+1))) for i,r in enumerate(v)] for k,v in data.items() if isinstance(v,list)}
 else:
  sheets,meta=ds_load(raw,name,{})
  if meta.get('formulaErrors'):raise ValueError('UNVERIFIED_WORKBOOK_FORMULA')
  tables={}
  for key,mapping in cfg['tables'].items():
   if mapping['sheet'] not in sheets:raise ValueError('REQUIRED_SHEET_MISSING:'+mapping['sheet'])
   rows=sheets[mapping['sheet']];headers=rows[0][1]
   if len(set(headers))!=len(headers):raise ValueError('DUPLICATE_HEADERS')
   fields=mapping.get('fields',{}); tables[key]=[]
   for n,values in rows[1:]:
    if not any(values):continue
    record={fields.get(h,h):values[i] if i<len(values) else '' for i,h in enumerate(headers) if h}
    record['_source']=mapping['sheet']+'!'+str(n)
    if mapping.get('recordType') and record.get('recordType')!=mapping['recordType']:continue
    tables[key].append(record)
 if sum(len(v) for v in tables.values())>50000:raise ValueError('METHOD_ROW_LIMIT')
 for key in cfg['requiredTables']:
  if key not in tables:raise ValueError('REQUIRED_TABLE_MISSING:'+key)
 def num(v):
  try:
   if v is None or v=='':return None
   n=D(str(v));return n if n.is_finite() else None
  except InvalidOperation:return None
 def quant(v):return None if v is None else format(v.quantize(D('.001'),rounding=ROUND_HALF_UP).normalize(),'f')
 def kg(r,field='weight'):
  value=num(r.get(field));factor=num(cfg['unitFactors'].get(r.get('unit','')))
  if value is None or factor is None or factor<=0 or value<0:
   issue('incomplete','WEIGHT_OR_UNIT_MISSING',r['_source'],'保留原行，重量或单位待核；不推定单位');return None
  return value*factor
 def unique(rows,fields):
  out=[];seen={};bad=set()
  for r in rows:
   key=tuple(str(r.get(x,'')) for x in fields)
   if any(not x for x in key):issue('incomplete','KEY_MISSING',r['_source'],','.join(fields));continue
   content={k:v for k,v in r.items() if k!='_source'}
   if key in seen:
    if content==seen[key][1]:issue('duplicate','IDENTICAL_EXPORT',r['_source'],'同节点同标识同内容，保留首行 '+seen[key][0]['_source'])
    else:bad.add(key);issue('conflict','CONFLICTING_DUPLICATE',r['_source'],'同业务键内容冲突，不能取首行推导最终值')
   else:seen[key]=(r,content);out.append(r)
  return [r for r in out if tuple(str(r.get(x,'')) for x in fields) not in bad]
 def index(rows,key):
  out={}
  for r in rows:
   v=r.get(key)
   if not v or v in out:raise ValueError('MASTER_KEY_MISSING_OR_DUPLICATE:'+key)
   out[v]=r
  return out
 waste=index(tables['wastes'],'waste'); warehouses=index(tables['warehouses'],'warehouse');batches=index(tables['batches'],'batch')
 events=unique(tables['events'],['node','id']); clean=[]; produce=[]
 for r in events:
  if r.get('waste') not in waste:issue('incomplete','WASTE_MASTER_MISSING',r['_source'],'不得凭名称推断一般固废/危废');continue
  try:dt.date.fromisoformat(r.get('date',''))
  except ValueError:issue('incomplete','DATE_INVALID',r['_source'],'业务日期待核');continue
  q=kg(r)
  if q is None:continue
  item=dict(r,kg=q,classification=waste[r['waste']]['classification']);clean.append(item)
  if r['node']=='产生':
   if r.get('workshop') not in cfg['workshops']:issue('incomplete','WORKSHOP_MISSING',r['_source'],'产生来源待核');continue
   produce.append(item)
 cutoff=prefs['cutoff'];period=cutoff[:7];date=dt.date.fromisoformat(cutoff)
 sheets=[]
 def sheet(title,headers,rows):
  if len(rows)>1000:raise ValueError('OUTPUT_ROW_LIMIT_NO_TRUNCATION')
  sheets.append({'name':title,'headers':headers,'rows':[[quant(x) if isinstance(x,D) else '未提供/待核' if x is None else str(x) for x in row] for row in rows]})
 summary={'fictional':cfg.get('fictional',False),'company':cfg['company'],'cutoff':cutoff,'methods':methods,'externalConnections':cfg['externalConnections']}
 if 'ledger' in methods:
  sheet('整理台账',['业务单号','业务节点','业务日期','所属车间','废物类别','废物名称','重量','单位','分类来源','原始位置'],[[r['id'],r['node'],r['date'],r.get('workshop',''),r['waste'],waste[r['waste']]['name'],r['kg'],'kg',r['classification'],r['_source']] for r in clean])
  summary['ledger']={'inputRows':len(tables['events']),'uniqueRows':len(events),'validRows':len(clean),'produceRows':len(produce),'sourcePositions':'完整输入，不是预览抽样'}
 # Always prepare the entire valid produce table for the existing formal DataAnalysis engine.
 analysis={'name':'产废分析输入','headers':['业务单号','业务节点','业务日期','所属车间','废物类别','废物名称','重量','单位','记录状态'],'rows':[[r['id'],'产生',r['date'],r['workshop'],r['waste'],waste[r['waste']]['name'],quant(r['kg']),'kg','有效'] for r in produce]}
 summary['analysisInput']={'complete':len(produce)==len(set((r.get('node'),r.get('id')) for r in tables['events'] if r.get('node')=='产生')) and not any(x['kind']=='conflict' for x in issues),'rows':len(produce),'periods':sorted(set(r['date'][:7] for r in produce)),'note':'交给现有 inspect_structured_data / analyze_waste_data；本处理器不另算正式月报'}
 if 'inventory' in methods:
  stock=collections.defaultdict(D);refs=collections.defaultdict(list);inventoryIncomplete=False
  def change(r,wh,batch,amount):
   nonlocal inventoryIncomplete
   if wh not in warehouses or batch not in batches or batches[batch]['waste']!=r.get('waste'):
    inventoryIncomplete=True;issue('incomplete','INVENTORY_BOUNDARY_UNKNOWN',r['_source'],'库区/批次/废物主数据不一致');return
   stock[(wh,batch)]+=amount;refs[(wh,batch)].append(r['_source'])
  for r in tables['balances']:
   if r['kind']=='OPENING':
    q=kg(r)
    if q is None:inventoryIncomplete=True
    else:change(r,r['warehouse'],r['batch'],q)
  for r in clean:
   if r['date']>cutoff:continue
   if r['node'] not in ['入库','出库','移库','调整']:continue
   q=r['kg'];node=r['node']
   if node=='移库':change(r,r.get('warehouse'),r.get('batch'),-q);change(r,r.get('toWarehouse'),r.get('batch'),q)
   else:change(r,r.get('warehouse'),r.get('batch'),q*(-1 if node=='出库' or node=='调整' and r.get('direction')=='-' else 1))
  # Invalid stock events cannot silently disappear from a final balance.
  if any(r.get('node') in ['入库','出库','移库','调整'] and not any(c['_source']==r['_source'] for c in clean) for r in events):inventoryIncomplete=True
  counts={}
  for r in unique([r for r in tables['balances'] if r['kind']=='COUNT'],['warehouse','batch','date']):
   if r['date']==cutoff:counts[(r['warehouse'],r['batch'])]=(kg(r),r['_source'])
  rows=[];physical=D(0);book=D(0);complete=not inventoryIncomplete;whTotals=collections.defaultdict(D);age=[]
  for key in sorted(set(stock)|set(counts)):
   wh,batch=key;q=stock[key];c,ref=counts.get(key,(None,''));delta=c-q if c is not None else None
   if c is None:complete=False;issue('incomplete','COUNT_MISSING',wh+'/'+batch,'期末盘点缺失，不能给最终实存差异')
   else:physical+=c
   book+=q;whTotals[wh]+=q
   born=dt.date.fromisoformat(batches[batch]['received']);days=(date-born).days
   if q<0:complete=False;issue('conflict','NEGATIVE_STOCK',wh+'/'+batch,'账面负库存待核')
   if q>0 and days>=int(prefs['internalAgeDays']):age.append({'warehouse':wh,'batch':batch,'kg':quant(q),'days':days,'basis':'企业内部关注阈值，非法定期限'})
   rows.append([wh,batch,batches[batch]['waste'],q,c,delta,days,'；'.join(refs[key]+[ref]),'待核' if inventoryIncomplete else '已按提供事件核算'])
  if prefs.get('differencesOnly'):rows=[r for r in rows if r[5] is None or r[5]!=0]
  sheet('库存差异',['库区','批次','废物','账面kg','盘点kg','差异kg','批次天数','来源','状态'],rows)
  attention=[]
  for wh,q in whTotals.items():
   cap=num(warehouses[wh].get('capacityKg'));ratio=q/cap*100 if cap and cap>0 else None
   if ratio is None:issue('incomplete','CAPACITY_MISSING',warehouses[wh]['_source'],'容量缺失，不算使用率')
   elif ratio>=num(prefs['capacityPercent']):attention.append({'warehouse':wh,'bookKg':quant(q),'capacityPercent':quant(ratio),'thresholdPercent':str(prefs['capacityPercent']),'basis':'个人/企业内部提醒，非法规裁决'})
  summary['inventory']={'bookKg':quant(book) if not inventoryIncomplete else None,'knownBookKg':quant(book),'physicalKg':quant(physical) if complete else None,'differenceKg':quant(physical-book) if complete else None,'complete':complete,'capacityAttention':attention,'batchAttention':age,'groupBy':'warehouse,batch'}
  if not prefs.get('differencesOnly'):sheet('贮存关注',['库区','批次/容量','内部关注','依据'],[[a['warehouse'],a.get('batch','容量'),json.dumps(a,ensure_ascii=False),'内部规则，法规期限未配置'] for a in age+attention])
 # Explicit links only. Distinct weigh points and cross-period receipts remain separate.
 tickets=unique(tables['tickets'],['kind','id']) if any(x in methods for x in ['transfer','settlement']) else []; shipRows=unique(tables['shipments'],['shipment']) if any(x in methods for x in ['transfer','settlement']) else []; ships=index(shipRows,'shipment')
 for r in tickets:
  if r.get('shipment') not in ships:issue('incomplete','UNLINKED_DOCUMENT',r['_source'],'未提供清运业务号；不得按重量/金额匹配')
 def total(rows):
  values=[kg(x) for x in rows];return sum((x for x in values if x is not None),D(0)) if rows and all(x is not None for x in values) else None
 transfer=[];shipInfo={}
 for sid,s in ships.items():
  out=[r for r in clean if r['node']=='出库' and r.get('shipment')==sid]; linked=[r for r in tickets if r.get('shipment')==sid]
  if any(r.get('waste')!=s.get('waste') for r in out+linked):issue('conflict','SHIPMENT_OBJECT_CONFLICT',s['_source'],'业务号关联对象冲突');objectOkay=False
  else:objectOkay=True
  by={k:[r for r in linked if r['kind']==k] for k in ['WEIGH','MANIFEST','RECEIVE']};qout=sum((r['kg'] for r in out),D(0)) if out else None
  weights={k:total(v) for k,v in by.items()};known=sum((kg(r) or D(0) for r in by['RECEIVE']),D(0))
  atCutoff=total([r for r in by['RECEIVE'] if r.get('date','')<=cutoff]);late=any(r.get('date','')>cutoff for r in by['RECEIVE'])
  status='待核' if weights['RECEIVE'] is None or not objectOkay else '跨期接收已到，期末未闭合' if late else '资料关联已闭合'
  if qout is None:status='出库记录未提供或无效'
  if not by['MANIFEST'] and waste[s['waste']]['classification']=='hazardous':status='联单资料未提供'
  delta=weights['WEIGH']-qout if qout is not None and weights['WEIGH'] is not None else None
  shipInfo[sid]={'weights':weights,'out':qout,'knownReceived':known,'status':status,'objectOkay':objectOkay}
  transfer.append([sid,s['waste'],qout,weights['WEIGH'],weights['MANIFEST'],weights['RECEIVE'],known,atCutoff,delta,status,'；'.join(r['_source'] for r in out+linked)])
 if 'transfer' in methods:
  sheet('清运资料核对',['清运号','废物','出库kg','磅单kg','联单kg','全部接收kg','已知接收kg','截至期末接收kg','称重点差kg','状态','关联来源'],transfer)
  summary['transfer']={'shipments':len(transfer),'pending':[{'shipment':r[0],'status':r[9]} for r in transfer if r[9]!='资料关联已闭合'],'matching':'显式清运号；一对多单据全量求和；不同称重点差异不直接判违规'}
 if 'settlement' in methods:
  contracts=index(tables['contracts'],'contract'); bills=unique(tables['bills'],['bill']); rows=[];pending=[]
  for b in bills:
   s=ships.get(b.get('shipment'));c=contracts.get(b.get('contract'));info=shipInfo.get(b.get('shipment'));reasons=[]
   if not s or not c or not info:issue('incomplete','CONTRACT_OR_SHIPMENT_MISSING',b['_source'],'合同/清运关联未提供');continue
   if c.get('waste')!=s.get('waste'):reasons.append('合同废物与清运对象冲突')
   verification=cfg.get('contractVerification',{});quote=c.get('quote','')
   for key in ['rate','transportPerTrip']:
    pattern=verification.get(key+'Pattern','')
    matches=re.findall(pattern,quote) if pattern and len(pattern)<500 else []
    if len(matches)!=1 or num(matches[0])!=num(c.get(key)):reasons.append('合同结构化'+key+'与条款摘录不一致或未能核实')
   token=verification.get('weightBasisTokens',{}).get(c.get('weightBasis'))
   if not token or token not in quote:reasons.append('合同结算重量点未核实')
   if not re.search(verification.get('includedTaxPattern',r'(?!)'),quote):reasons.append('含税条款未核实')
   if c.get('direction') not in ['回收收入','处置支出'] or c.get('direction') not in quote:reasons.append('合同收支方向未核实')
   basis=info['weights'].get(c.get('weightBasis'));rate=num(c.get('rate'));transport=num(c.get('transportPerTrip'));trips=num(s.get('trips'))
   if basis is None:reasons.append('合同指定结算重量待核')
   if rate is None or rate<0 or c.get('rateUnit')!='CNY/t':reasons.append('合同单价或计价单位待核')
   if transport is None or transport<0:reasons.append('运输费条款待核')
   if transport and (trips is None or trips<0 or trips!=trips.to_integral_value()):reasons.append('实际车次未提供')
   if c.get('taxMode')!='included':reasons.append('税费条件未确认')
   if not c.get('quote') or not c.get('sourcePath') or c.get('sourcePath') in payload.get('unverifiedContracts',[]):reasons.append('合同条款证据未提供或原文未核实')
   if not info['objectOkay'] or info['weights']['RECEIVE'] is None:reasons.append('接收凭据不完整或对象冲突')
   component=basis/1000*rate if basis is not None and rate is not None and c.get('rateUnit')=='CNY/t' else None
   expected=(component+transport*(trips or 0)).quantize(D('.01'),rounding=ROUND_HALF_UP) if not reasons else None
   billed=num(b.get('amount'));delta=billed-expected if billed is not None and expected is not None else None
   status='条件待核，不能生成最终应付/应收' if reasons else '金额差异待核' if delta!=0 else '金额一致（凭据仍按资料清单核查）'
   if reasons or delta!=0:pending.append({'shipment':b['shipment'],'expected':quant(expected),'difference':quant(delta),'reasons':reasons,'status':status})
   rows.append([b['bill'],b['shipment'],c['direction'],c['weightBasis'],basis,rate,c['rateUnit'],trips,component,expected,billed,delta,status,'；'.join(reasons),c['quote'],c['_source']+'；'+b['_source']])
  sheet('结算对账',['账单','清运号','收支方向','合同重量点','重量kg','单价','单位','车次','已知重量费元','条件核算金额元','账单元','差额元','状态','待核条件','合同条款摘录','来源'],rows)
  summary['settlement']={'bills':len(rows),'pending':pending,'note':'回收收入与处置支出分列；条件金额不是付款裁决，缺关键条件无最终金额'}
 attachments=tables['attachments'] if 'checklist' in methods else []; actual=payload.get('attachments',{}); checklist=[]
 for r in attachments:
  p=r.get('path',''); entry=actual.get(p,{});state='已提供' if entry.get('available') else '未提供'
  if entry.get('available') and entry.get('sha256')!=r.get('sha256'):state='明确冲突：附件指纹与目录不符'
  checklist.append([r.get('shipment',''),r['kind'],p,state,r['_source'],entry.get('sha256','')])
 # A requirement without a directory entry is incomplete, not automatically illegal.
 for r in (tables['requirements'] if 'checklist' in methods else []):
  if not any(a.get('shipment')==r.get('shipment') and a.get('kind')==r.get('kind') for a in attachments):checklist.append([r.get('shipment',''),r['kind'],'','清单不完整：未列目录',r['_source'],''])
 if 'checklist' in methods:
  sheet('资料准备',['业务号','资料类别','文件','证据状态','目录来源','实读SHA256'],checklist)
  summary['checklist']={'items':len(checklist),'missing':sum(r[3]=='未提供' for r in checklist),'conflicts':sum(r[3].startswith('明确冲突') for r in checklist),'incomplete':sum(r[3].startswith('清单不完整') for r in checklist),'externalSubmission':False,'basis':cfg['requirementsBasis'],'note':'仅资料准备；不自动判断合规，不对外申报'}
 # Private preference can intentionally limit the deliverable to inventory differences.
 if prefs.get('differencesOnly') and methods==['inventory']:sheets=[s for s in sheets if s['name']=='库存差异']
 if issues and not (prefs.get('differencesOnly') and methods==['inventory']):sheet('处理问题',['类型','代码','原始位置','处理依据'],[[r['kind'],r['code'],r['source'],r['detail']] for r in issues])
 for item in sheets:
  item['name']=prefs.get('outputSheets',{}).get(item['name'],item['name'])
 return {'summary':summary,'sheets':sheets,'analysisSheet':analysis,'issues':issues,'coverage':{'inputRows':sum(len(v) for v in tables.values()),'allRowsProcessed':True,'truncated':False},'attachmentPaths':sorted(set(r['path'] for r in attachments if r.get('path'))),'contractSources':[{'path':r.get('sourcePath'),'quote':r.get('quote'),'source':r['_source']} for r in tables['contracts']] if 'settlement' in methods else []}

if __name__=='__main__':
 try:
  payload=json.load(sys.stdin);print(json.dumps(run(payload),ensure_ascii=False,allow_nan=False))
 except Exception as e:
  print(json.dumps({'error':str(e)[:300]},ensure_ascii=False));sys.exit(1)
