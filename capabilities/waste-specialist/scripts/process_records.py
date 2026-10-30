"""Portable, deterministic industry methods. stdin JSON -> stdout JSON. No file/network I/O.
Workbook loading is supplied by ZhenWork's existing bounded ds_load adapter.
"""
import sys,json,base64,datetime as dt,collections,re
from decimal import Decimal,InvalidOperation,ROUND_HALF_UP
D=Decimal

# Industry adaptation of upstream workflows 18/16/20. Reuses normalized results, never re-cleans their raw inputs.
def comparison_method(payload):
 from decimal import localcontext
 with localcontext() as ctx:
  ctx.prec=50
  return comparison_compute(payload)

def comparison_compute(payload):
 cfg=payload['company']['analysis'];pref=payload['preferences']['analysis'];methods=payload.get('methods') or payload['preferences']['methods']
 periods=pref['periods'];dims=pref['groupBy'];issues=[];sheets=[]
 displayUnit=pref.get('weightDisplayUnit','kg');displayFactor=D(cfg['weightDisplayFactors'].get(displayUnit,'0'))
 if not displayFactor.is_finite() or displayFactor<=0:raise ValueError('COMPARISON_WEIGHT_DISPLAY_UNIT_INVALID')
 if len(periods)!=2 or periods[0]>=periods[1] or any(not re.fullmatch(r'\d{4}-(0[1-9]|1[0-2])',p) for p in periods):raise ValueError('COMPARISON_TWO_ORDERED_PERIODS_REQUIRED')
 if not dims or len(dims)>4 or any(x not in cfg['dimensions'] for x in dims):raise ValueError('COMPARISON_GROUPS_INVALID')
 scales=pref['precision']
 for kind in ['weight','production','intensity','percent','money','price']:
  if not isinstance(scales.get(kind),int) or not 0<=scales[kind]<=8:raise ValueError('COMPARISON_PRECISION_INVALID')
 def n(v):
  try:
   if v is None or v=='':return None
   x=D(str(v));return x if x.is_finite() else None
  except InvalidOperation:return None
 def f(v,kind=None):
  if v is None:return None
  if kind:v=v.quantize(D(1).scaleb(-scales[kind]),rounding=ROUND_HALF_UP)
  return format(v.normalize(),'f')
 def cell(v,kind='weight'):
  if v is None:return '待核/不可比'
  if not isinstance(v,D):return v
  q=v.quantize(D(1).scaleb(-scales[kind]),rounding=ROUND_HALF_UP)
  if len(q.normalize().as_tuple().digits)>15:raise ValueError('COMPARISON_XLSX_PRECISION_LIMIT')
  return int(q) if q==q.to_integral_value() else float(q)
 def issue(code,source,detail):issues.append({'kind':'pending','code':code,'source':source,'detail':detail})
 def sheet(key,headers,rows,kinds=None):
  if pref['outputs'].get('detail') is False and key in ['产废强度','既有结算复用']:return
  if len(rows)>1000:raise ValueError('COMPARISON_OUTPUT_LIMIT_NO_TRUNCATION')
  sheets.append({'name':pref.get('sheetNames',{}).get(key,key),'headers':headers,'rows':[[cell(v,(kinds or {}).get(i,'weight')) if isinstance(v,D) or v is None else v for i,v in enumerate(row)] for row in rows]})
 def tables(raw,name,spec):
  if name.lower().endswith('.json'):
   data=json.loads(raw);data=data.get('tables',data)
   if not isinstance(data,dict):raise ValueError('COMPARISON_TABLES_REQUIRED')
   out={}
   for key,m in spec.items():
    records=data.get(key,[])
    if not isinstance(records,list):raise ValueError('COMPARISON_TABLE_ARRAY_REQUIRED')
    out[key]=[{**m.get('defaults',{}),**{m.get('fields',{}).get(k,k):v for k,v in row.items()},'_source':name+'#'+key+':'+str(i+1)} for i,row in enumerate(records)]
  else:
   data,meta=ds_load(raw,name,{})
   if meta.get('formulaErrors'):raise ValueError('COMPARISON_SOURCE_FORMULA_UNVERIFIED')
   out={}
   for key,m in spec.items():
    rows=data.get(m['sheet'],[]);header=int(m.get('headerRow',1));heads=next((v for row,v in rows if row==header),[])
    if len(set(heads))!=len(heads):raise ValueError('COMPARISON_DUPLICATE_HEADERS')
    out[key]=[{**m.get('defaults',{}),**{m.get('fields',{}).get(h,h):values[i] if i<len(values) else '' for i,h in enumerate(heads) if h},'_source':name+'!'+m['sheet']+':'+str(row)} for row,values in rows if row>header and any(values)]
  if sum(len(x) for x in out.values())>50000:raise ValueError('COMPARISON_ROW_LIMIT')
  return out
 raw=base64.b64decode(payload['input'],validate=True);data=tables(raw,payload['name'],cfg['tables']);bindings=data.get('sources',[])
 paths=sorted(set(str(r.get('path','')) for r in bindings if r.get('path')))
 if len(paths)>20:raise ValueError('COMPARISON_SOURCE_LIMIT_20')
 base={'summary':{'methods':methods},'sheets':[],'analysisSheet':{'name':'产废分析输入','headers':[],'rows':[]},'issues':[],'attachmentPaths':paths,'contractSources':[],'dataSourcePaths':paths}
 if any(p not in payload.get('attachments',{}) for p in paths):return {**base,'needsDataSources':True,'coverage':{'inputRows':sum(map(len,data.values())),'allRowsProcessed':False,'truncated':False}}
 verified={};sourceRows=0;sourceComplete=True
 for b in bindings:
  role=b.get('role');entry=payload.get('attachments',{}).get(b.get('path'),{})
  if role not in cfg['sources']:issue('SOURCE_ROLE_UNKNOWN',b['_source'],'来源用途未配置');sourceComplete=False;continue
  if not entry.get('available') or not entry.get('contentBase64'):issue('VERIFIED_SOURCE_MISSING',b['_source'],'既有核对底稿未提供；不补造其数值');sourceComplete=False;continue
  if b.get('sha256') and b['sha256']!=entry.get('sha256'):issue('SOURCE_VERSION_CONFLICT',b['_source'],'实际SHA与指定版本不一致，该来源不参与计算');sourceComplete=False;continue
  if role in verified:raise ValueError('COMPARISON_SOURCE_ROLE_DUPLICATED')
  out=tables(base64.b64decode(entry['contentBase64'],validate=True),b['path'],{role:cfg['sources'][role]})[role];sourceRows+=len(out);verified[role]=out
 if not bindings:issue('SOURCE_BINDING_MISSING',payload['name'],'未绑定既有核对结果；仅分析已提供资料');sourceComplete=False
 summary={'fictional':payload['company'].get('fictional',False),'methods':methods,'periods':periods,'configApplied':{'groupBy':dims,'periods':periods,'costDateField':pref['costDateField'],'precision':scales,'differencesOnly':pref.get('differencesOnly',False),'outputs':pref['outputs']},'scope':'复用既有核对结果；新增资料为模拟资料，不证明工艺因果、付款或合规','externalConnections':payload['company']['externalConnections']}
 def canonical(row):
  row=dict(row)
  for key,aliases in cfg.get('objectAliases',{}).items():
   if row.get(key) in aliases:row[key]=aliases[row[key]]
  return row
 def gkey(row):return tuple(str(row.get(k,'')) for k in dims)+(str(row.get('scope','')),)
 def percent(before,after):return (after-before)/before*100 if before is not None and after is not None and before!=0 else None
 if 'intensity' in methods:
  waste={};production={};allkeys=set();seen=set()
  for rawrow in verified.get('verifiedWaste',[]):
   row=canonical(rawrow);period=str(row.get('date',''))[:7]
   if period not in periods:continue
   key=gkey(row);allkeys.add(key);v=n(row.get('weightKg'));record=(period,str(row.get('id','')))
   if record in seen:raise ValueError('COMPARISON_NORMALIZED_SOURCE_DUPLICATE')
   seen.add(record)
   if v is None or v<0:issue('VERIFIED_WEIGHT_INVALID',row['_source'],'规范重量无效，不当作零');waste[(period,key)]=None;continue
   if (period,key) not in waste:waste[(period,key)]={'value':D(0),'sources':[]}
   if waste[(period,key)] is not None:waste[(period,key)]['value']+=v;waste[(period,key)]['sources'].append(row['_source'])
  for rawrow in data.get('production',[]):
   row=canonical(rawrow);period=str(row.get('period',''))[:7]
   if period not in periods:continue
   key=gkey(row);allkeys.add(key);entry=production.setdefault((period,key),{'value':D(0),'units':set(),'mix':set(),'sources':[],'valid':True,'composition':collections.defaultdict(D)});v=n(row.get('quantity'));unit=cfg['productionUnits'].get(row.get('unit'));entry['sources'].append(row['_source']);entry['mix'].add(str(row.get('comparability','')))
   if v is None or v<0 or not unit:entry['valid']=False;issue('PRODUCTION_MISSING_OR_UNIT_UNKNOWN',row['_source'],'缺生产量或单位；不推定分母')
   else:entry['value']+=v*D(unit['factor']);entry['units'].add(unit['canonical']);entry['composition'][str(row.get('productGroup',''))]+=v*D(unit['factor'])
  items={};detail=[]
  for key in sorted(allkeys):
   for period in periods:
    w=waste.get((period,key));p=production.get((period,key));reasons=[]
    if not w:reasons.append('缺同范围产废量；覆盖范围不一致或未提供')
    if not p or not p['valid']:reasons.append('生产量缺失/无效')
    elif p['value']==0:reasons.append('生产分母为零')
    if p and len(p['units'])!=1:reasons.append('不同生产单位不可相加')
    if any(not value for value in key):reasons.append('对象或范围映射不完整')
    valid=not reasons;quantity=p['value'] if p and p['valid'] and len(p['units'])==1 else None;weight=w['value'] if w else None;unit=next(iter(p['units'])) if p and len(p['units'])==1 else ''
    v=weight*displayFactor/quantity if valid else None;sources=(w['sources'] if w else [])+(p['sources'] if p else [])
    item={'group':dict(zip(dims,key[:-1])),'scope':key[-1],'period':period,'production':quantity,'unit':unit,'wasteKg':weight,'intensity':v,'mix':p['mix'] if p else set(),'composition':{k:v/p['value'] for k,v in p['composition'].items()} if p and p['value'] and p['valid'] and len(p['units'])==1 else {},'sources':sources,'reasons':reasons};items[(period,key)]=item
    detail.append([period,' / '.join(key[:-1]),key[-1],quantity,unit,weight*displayFactor if weight is not None else None,v,displayUnit+'/'+unit if unit else '待核','；'.join(reasons) or '同范围可算','；'.join(sources)])
    if reasons:issue('INTENSITY_NOT_SUPPORTED','；'.join(sources) or str(key),'；'.join(reasons))
  changes=[];groupSummary=[]
  def change(a,b,label,scope):
   reason=[]
   if a['intensity'] is None or b['intensity'] is None:reason.append('缺少可比期间分母/范围')
   if a['unit']!=b['unit']:reason.append('生产单位不一致')
   if a['mix']!=b['mix'] or '' in a['mix'] or '' in b['mix'] or a.get('composition',{})!=b.get('composition',{}):reason.append('产品结构/可比组未确认一致，优先分产品组')
   comparable=not reason
   vals=[b[k]-a[k] if a[k] is not None and b[k] is not None else None for k in ['production','wasteKg']]
   ps=[percent(a[k],b[k]) for k in ['production','wasteKg']]
   if a['unit']!=b['unit']:vals[0]=None;ps[0]=None
   ir=percent(a['intensity'],b['intensity']) if comparable else None
   if comparable and a['intensity']==0:reason.append('前期单位产废为零，只列绝对差额')
   if comparable and a['production']==0 or comparable and a['wasteKg']==0:reason.append('前期为零的指标不输出增长百分比')
   result={'group':label,'scope':scope,'productionBefore':f(a['production']),'productionAfter':f(b['production']),'productionChange':f(vals[0]),'productionChangePercent':f(ps[0],'percent'),'unit':a['unit'] if a['unit']==b['unit'] else '不可比','wasteBeforeKg':f(a['wasteKg']),'wasteAfterKg':f(b['wasteKg']),'wasteChangeKg':f(vals[1]),'wasteChangePercent':f(ps[1],'percent'),'unitBefore':a['unit'],'unitAfter':b['unit'],'weightDisplayUnit':displayUnit,'intensityUnit':displayUnit+'/'+a['unit'] if a['unit']==b['unit'] else '不可比','intensityBefore':f(a['intensity'],'intensity'),'intensityAfter':f(b['intensity'],'intensity'),'intensityChange':f(b['intensity']-a['intensity'],'intensity') if comparable else None,'intensityChangePercent':f(ir,'percent'),'comparable':comparable,'limitations':reason}
   changes.append([label,scope,a['production'],b['production'],a['unit'] if a['unit']==b['unit'] else '不可比',ps[0],a['wasteKg']*displayFactor if a['wasteKg'] is not None else None,b['wasteKg']*displayFactor if b['wasteKg'] is not None else None,ps[1],a['intensity'] if comparable else None,b['intensity'] if comparable else None,ir,'；'.join(reason) or '可比；统计变化不证明工艺原因'])
   return result
  for key in sorted(allkeys):groupSummary.append(change(items[(periods[0],key)],items[(periods[1],key)],' / '.join(key[:-1]),key[-1]))
  total=[];scope=pref['aggregateScope'];keys=[k for k in allkeys if k[-1]==scope];aggregate=[]
  for period in periods:
   selected=[items[(period,k)] for k in keys];units=set(i['unit'] for i in selected);valid=bool(selected) and all(i['intensity'] is not None for i in selected) and len(units)==1
   quantity=sum((i['production'] for i in selected),D(0)) if valid else None;weight=sum((i['wasteKg'] for i in selected),D(0)) if selected and all(i['wasteKg'] is not None for i in selected) else None
   aggregate.append({'production':quantity,'wasteKg':weight,'unit':next(iter(units)) if len(units)==1 else '不可比','intensity':weight*displayFactor/quantity if valid and quantity and weight is not None else None,'mix':set().union(*(i['mix'] for i in selected)) if selected else set(),'composition':{product:sum((i['production']*share for i in selected for product2,share in i['composition'].items() if product2==product),D(0))/quantity for product in set(p for i in selected for p in i['composition'])} if quantity else {}})
  whole=change(aggregate[0],aggregate[1],'配置范围合计',scope)
  sheet('产废强度', ['期间','对象/产品组','覆盖范围','生产量','生产单位','产生重量'+displayUnit,'单位产废','强度单位','状态','来源'],detail,{3:'production',5:'weight',6:'intensity'})
  visible=[r for r in changes if not pref.get('differencesOnly') or r[2]!=r[3] or r[6]!=r[7] or '可比；' not in r[-1]]
  sheet('强度变化',['对象/产品组','覆盖范围','上期生产量','本期生产量','生产单位','生产变化%','上期产废'+displayUnit,'本期产废'+displayUnit,'产废变化%','上期强度','本期强度','强度变化%','边界'],visible,{2:'production',3:'production',5:'percent',6:'weight',7:'weight',8:'percent',9:'intensity',10:'intensity',11:'percent'})
  summary['intensity']={'total':whole,'groups':groupSummary,'observation':'总量与单位指标分别解释；统计相关性不证明工艺改善','thresholdPercent':pref['intensityAlertPercent'],'attention':[r['group'] for r in groupSummary if r['intensityChangePercent'] is not None and abs(D(r['intensityChangePercent']))>=D(pref['intensityAlertPercent'])]}
 if 'cost_change' in methods:
  allowed=cfg['cost'];dateField=pref['costDateField'];costGroups=pref.get('costGroupBy',['project','supplier']);groupCoverage=True
  if not costGroups or len(costGroups)>4 or any(k not in allowed['groupDimensions'] for k in costGroups):raise ValueError('COMPARISON_COST_GROUPS_INVALID')
  if dateField not in ['businessDate','settlementDate','paymentDate']:raise ValueError('COMPARISON_COST_DATE_FIELD_INVALID')
  entries={};pending=[];pendingProjects=set();unidentifiedPending=False;cat=collections.defaultdict(lambda:[D(0),D(0)]);cash=collections.defaultdict(D)
  for row in data.get('costs',[]):
   date=str(row.get(dateField,''));period=date[:7]
   if not re.fullmatch(r'\d{4}-\d{2}-\d{2}',date):issue('COST_DATE_MISSING',row['_source'],'选定的费用归属日期未提供');pending.append(row['_source']);pendingProjects.add(str(row.get('project','')));unidentifiedPending=unidentifiedPending or not row.get('project');continue
   if period not in periods:continue
   category=allowed['categories'].get(row.get('category'));direction=allowed['directions'].get(row.get('direction'));tax=allowed['taxBases'].get(row.get('taxBasis'));recurrence=allowed['recurrences'].get(row.get('recurrence'));amount=n(row.get('amount'));reasons=[]
   if not category or not direction or not tax or not recurrence:reasons.append('费用分类/收支/税费/一次性口径缺失')
   if amount is None or amount<0:reasons.append('实际结算金额缺失或无效')
   if row.get('conditionState') not in allowed['completeStates']:reasons.append('计价条件仍待核')
   if not row.get('contractRef') or not row.get('conditionQuote'):reasons.append('合同条件/来源引用未提供')
   basis=str(row.get('basis',''));currency=str(row.get('currency',''))
   if basis not in allowed['bases'] or currency not in allowed['currencies']:reasons.append('金额口径/币种未配置')
   pricing=row.get('pricingType');quantity=price=None;unit=''
   if pricing=='linear':
    qu=allowed['quantityUnits'].get(row.get('quantityUnit'));pu=allowed['priceUnits'].get(row.get('priceUnit'));q=n(row.get('quantity'));p=n(row.get('price'))
    if not qu or not pu or qu['canonical']!=pu['denominator'] or q is None or p is None or q<0 or p<0:reasons.append('计价数量/单位/单价缺失或不一致')
    else:
     quantity=q*D(qu['factor']);price=p*D(pu['factor']);unit=qu['canonical']
     if amount is not None and abs((quantity*price).quantize(D(1).scaleb(-scales['money']),rounding=ROUND_HALF_UP)-amount)>0:reasons.append('给定的已核对金额与价量不一致，不能作纯价量分解')
   elif pricing not in allowed['actualOnlyPricingTypes']:reasons.append('未配置的复杂计价，不强套价量公式')
   if reasons:pendingProjects.add(str(row.get('project','')));unidentifiedPending=unidentifiedPending or not row.get('project');issue('COST_CONDITIONS_PENDING',row['_source'],'；'.join(reasons));pending.append({'project':row.get('project'),'source':row['_source'],'reasons':reasons,'knownAmount':f(amount)});continue
   group={k:str(row.get(k) or '未提供归属') for k in costGroups}
   if any(v=='未提供归属' for v in group.values()):groupCoverage=False;issue('COST_GROUP_ATTRIBUTION_MISSING',row['_source'],'缺费用分组归属；保留未归属组，不自动分摊')
   groupLabel=json.dumps(group,ensure_ascii=False,sort_keys=True)
   key=tuple(str(row.get(k,'')) for k in ['project','supplier','waste'])+(category,direction,tax,recurrence,basis,currency,str(pricing),unit,groupLabel)
   if any(not v for v in key[:10]):issue('COST_IDENTITY_MISSING',row['_source'],'项目/供应商/废物等匹配字段缺失');pending.append(row['_source']);pendingProjects.add(str(row.get('project','')));unidentifiedPending=unidentifiedPending or not row.get('project');continue
   if (period,key) in entries:raise ValueError('COMPARISON_COST_ITEM_PERIOD_DUPLICATED_SPLIT_PRICE_BANDS')
   entries[(period,key)]={'amount':amount,'q':quantity,'p':price,'source':row['_source'],'contract':row['contractRef'],'quote':row['conditionQuote'],'row':row}
   cat[(category,direction,tax,recurrence,basis,currency)][periods.index(period)]+=amount
   paid=n(row.get('paidAmount'));paidDate=str(row.get('paymentDate',''))[:7]
   if paid is not None and paidDate in periods:cash[(paidDate,direction,currency)]+=paid
  completeNewProjects=not pending
  decomposition=[];breakdown=[];totalByBucket=collections.defaultdict(lambda:[D(0),D(0),D(0),D(0),D(0)])
  for key in sorted(set(k for _,k in entries)):
   a=entries.get((periods[0],key));b=entries.get((periods[1],key));a0=a['amount'] if a else D(0);a1=b['amount'] if b else D(0);delta=a1-a0;qe=pe=D(0);other=delta;label='新增项目，单列' if not a else '退出项目，单列' if not b else '按实际费用差额单列（非价量分解）'
   blocked=key[0] in pendingProjects or (unidentifiedPending and (not a or not b))
   if blocked:
    sources='；'.join(e['source'] for e in [a,b] if e)
    decomposition.append([key[0],key[1],key[2],key[3],key[4],key[5],key[6],a['q'] if a else None,b['q'] if b else None,key[10],a['p'] if a else None,b['p'] if b else None,a['amount'] if a else None,b['amount'] if b else None,None,None,None,None,'另一期间/本项目仍待核，不认定新增退出或最终差额',sources,key[11]])
    breakdown.append({'project':key[0],'category':key[3],'direction':key[4],'before':None,'after':None,'difference':None,'quantityEffect':None,'priceEffect':None,'otherEffect':None,'decompositionConvention':'待核，不认定退出/新增','sources':sources})
    continue
   if a and b and key[9]=='linear':
    qe=(b['q']-a['q'])*a['p'];pe=b['q']*(b['p']-a['p']);other=delta-qe-pe;label='先数量后价格；其余列金额舍入差' if other else '先数量后价格；纯计算约定'
   if delta!=qe+pe+other:raise ValueError('COMPARISON_DECOMPOSITION_NOT_CLOSED')
   sources='；'.join(e['source']+' / '+e['contract']+' / '+e['quote'] for e in [a,b] if e)
   decomposition.append([key[0],key[1],key[2],key[3],key[4],key[5],key[6],a['q'] if a else None,b['q'] if b else None,key[10],a['p'] if a else None,b['p'] if b else None,a0,a1,delta,qe if label.startswith('先数量') else None,pe if label.startswith('先数量') else None,other,label,sources,key[11]])
   item={'project':key[0],'category':key[3],'direction':key[4],'taxBasis':key[5],'recurrence':key[6],'before':f(a0,'money'),'after':f(a1,'money'),'difference':f(delta,'money'),'quantityEffect':f(qe,'money') if label.startswith('先数量') else None,'priceEffect':f(pe,'money') if label.startswith('先数量') else None,'otherEffect':f(other,'money'),'decompositionConvention':label,'sources':sources,'group':json.loads(key[11])};breakdown.append(item)
   bucket=totalByBucket[(key[4],key[5],key[7],key[8])]
   for i,x in enumerate([a0,a1,qe,pe,other]):bucket[i]+=x
  for item in breakdown:
   ratio=percent(n(item['before']),n(item['after']));item['changePercent']=f(ratio,'percent');item['percentageBoundary']='前期为0，仅列绝对变化' if n(item['before'])==0 else '';item['alert']=ratio is not None and abs(ratio)>=D(pref['costAlertPercent'])
  totals=[{'direction':k[0],'taxBasis':k[1],'basis':k[2],'currency':k[3],'before':f(v[0],'money'),'after':f(v[1],'money'),'difference':f(v[1]-v[0],'money'),'quantityEffect':f(v[2],'money'),'priceEffect':f(v[3],'money'),'otherEffect':f(v[4],'money')} for k,v in totalByBucket.items()]
  for total in totals:
   matched=[v for k,v in cat.items() if k[1]==total['direction'] and k[2]==total['taxBasis'] and k[4]==total['basis'] and k[5]==total['currency']]
   total['before']=f(sum((v[0] for v in matched),D(0)),'money');total['after']=f(sum((v[1] for v in matched),D(0)),'money');total['difference']=f(D(total['after'])-D(total['before']),'money')
  if not completeNewProjects:
   for total in totals:
    total['knownSubtotalBefore']=total['before'];total['knownSubtotalAfter']=total['after'];total['basisLimitation']='仅已核对已提供小计，待核项目未计入，不是最终完整费用'
    for field in ['before','after','difference','quantityEffect','priceEffect','otherEffect']:total[field]=None
  legacy=[];legacyKnown=[];mapping={str(r.get('shipment')):r for r in data.get('legacyMap',[])}
  for row in verified.get('verifiedSettlement',[]):
   m=mapping.get(str(row.get('shipment')));amount=n(row.get('amount'));component=n(row.get('knownComponent'));status=str(row.get('status',''))
   period=str(m.get(dateField,''))[:7] if m else ''
   if period not in periods:
    if not m:issue('LEGACY_PERIOD_UNMAPPED',row['_source'],'旧核对结果缺期间归属映射，不猜月份')
    continue
   checked=any(t in status for t in cfg['legacyKnownStatuses']) and amount is not None
   legacy.append([period,row.get('shipment'),row.get('direction'),amount,component,'沿用合同核对金额；非现金支出' if checked else '继续待核，不纳入已确认完整费用',status,row['_source']])
   if not checked:pending.append({'shipment':row.get('shipment'),'knownComponent':f(component),'finalAmount':None,'status':status,'source':row['_source']})
   else:legacyKnown.append({'period':period,'shipment':row.get('shipment'),'direction':row.get('direction'),'contractCheckedAmount':f(amount,'money'),'source':row['_source']})
  sheet('费用变化分解',['项目','供应商','废物','分类','收支','税口径','一次性/持续','上期数量','本期数量','数量单位','上期单价','本期单价','上期结算额','本期结算额','差额','数量影响','价格影响','其他/新增退出/舍入','分解约定','明细/合同来源','对象分组'],[r for r in decomposition if not pref.get('differencesOnly') or r[14]!=0],{7:'production',8:'production',10:'price',11:'price',12:'money',13:'money',14:'money',15:'money',16:'money',17:'money'})
  sheet('费用分项',['分类','收支','税口径','一次性/持续','口径','币种','已核对上期小计','已核对本期小计','已核对差额','完整性边界'],[[*k,*v,v[1]-v[0],'新增给定范围完整；非全企业总额' if completeNewProjects else '仅已知小计，不能代替最终完整费用'] for k,v in cat.items()],{6:'money',7:'money',8:'money'})
  sheet('既有结算复用',['期间','业务号','收支','原核对金额','已知分量','本轮边界','原状态','原结果位置'],legacy,{3:'money',4:'money'})
  summary['costChange']={'dateField':dateField,'groupBy':costGroups,'groupCoverageComplete':groupCoverage,'totals':totals,'items':breakdown,'legacyKnown':legacyKnown,'pending':pending,'completeProvidedNewProjects':completeNewProjects,'completeEnterpriseExpense':False,'cashOut':[{ 'period':k[0],'direction':k[1],'currency':k[2],'amount':f(v,'money')} for k,v in cash.items()] or None,'cashBoundary':'未提供付款流水时不能把应付结算费用称现金支出','productionCostAttribution':'未提供可靠批次到当期产生的归属；不把历史库存处置费用除以当期产废量','thresholdPercent':pref['costAlertPercent'],'attention':[i['project'] for i in breakdown if i['alert']], 'legacyChanges':[{'direction':direction,'before':f(sum((D(i['contractCheckedAmount']) for i in legacyKnown if i['direction']==direction and i['period']==periods[0]),D(0)),'money'),'after':f(sum((D(i['contractCheckedAmount']) for i in legacyKnown if i['direction']==direction and i['period']==periods[1]),D(0)),'money'),'difference':f(sum((D(i['contractCheckedAmount'])*(1 if i['period']==periods[1] else -1) for i in legacyKnown if i['direction']==direction),D(0)),'money'),'basis':'只沿用已有合同核对金额；非完整费用或现金证明'} for direction in sorted(set(i['direction'] for i in legacyKnown))]}
 if issues:sheet('待核与范围',['类型','代码','来源','待核事项'],[[r['kind'],r['code'],r['source'],r['detail']] for r in issues])
 summary['possibleFactors']=[{'status':'待核实的可能因素','text':s} for s in cfg['possibleFactors']]
 return {**base,'summary':summary,'sheets':sheets,'issues':issues,'needsDataSources':False,'coverage':{'inputRows':sum(map(len,data.values()))+sourceRows,'allRowsProcessed':True,'truncated':False,'sourceCoverageComplete':sourceComplete,'reusedNormalizedRows':sourceRows},'analysisSheet':{'name':'产废分析输入','headers':[],'rows':[]}}


def run(payload):
 cfg=payload['company']; prefs=payload['preferences']; methods=payload.get('methods') or prefs['methods']
 if not methods or any(x not in ['ledger','inventory','transfer','settlement','checklist','intensity','cost_change'] for x in methods):raise ValueError('METHOD_UNKNOWN')
 if any(x in ['intensity','cost_change'] for x in methods):
  if any(x not in ['intensity','cost_change'] for x in methods):raise ValueError('COMPARISON_USE_SAVED_RESULTS_AS_SEPARATE_STEP')
  return comparison_method(payload)
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
 def excel_number(v):
  rounded=v.quantize(D('.001'),rounding=ROUND_HALF_UP)
  if abs(rounded)>D('99999999999.999'):raise ValueError('XLSX_NUMERIC_PRECISION_LIMIT')
  return int(rounded) if rounded==rounded.to_integral_value() else float(rounded)
 def sheet(title,headers,rows):
  if len(rows)>1000:raise ValueError('OUTPUT_ROW_LIMIT_NO_TRUNCATION')
  sheets.append({'name':title,'headers':headers,'rows':[[excel_number(x) if isinstance(x,D) else '未提供/待核' if x is None else x if isinstance(x,int) else str(x) for x in row] for row in rows]})
 summary={'fictional':cfg.get('fictional',False),'company':cfg['company'],'cutoff':cutoff,'methods':methods,'externalConnections':cfg['externalConnections']}
 if 'ledger' in methods:
  sheet('整理台账',['业务单号','业务节点','业务日期','所属车间','废物类别','废物名称','重量','单位','分类来源','原始位置'],[[r['id'],r['node'],r['date'],r.get('workshop',''),r['waste'],waste[r['waste']]['name'],r['kg'],'kg',r['classification'],r['_source']] for r in clean])
  summary['ledger']={'inputRows':len(tables['events']),'uniqueRows':len(events),'validRows':len(clean),'produceRows':len(produce),'sourcePositions':'完整输入，不是预览抽样'}
 # Always prepare the entire valid produce table for the existing formal DataAnalysis engine.
 analysis={'name':'产废分析输入','headers':['业务单号','业务节点','业务日期','所属车间','废物类别','废物名称','重量','单位','记录状态'],'rows':[[r['id'],'产生',r['date'],r['workshop'],r['waste'],waste[r['waste']]['name'],excel_number(r['kg']),'kg','有效'] for r in produce]}
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
