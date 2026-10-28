export const COMPUTE_PYTHON = String.raw`def ds_date(value):
 s=ds_clean(value)
 for fmt in ['%Y-%m-%d','%Y/%m/%d','%Y.%m.%d','%Y年%m月%d日','%Y%m%d','%Y-%m-%d %H:%M:%S','%Y/%m/%d %H:%M:%S']:
  try:return dt.datetime.strptime(s,fmt).date()
  except ValueError:pass
 try:
  value=dt.datetime.fromisoformat(s.replace('Z','+00:00'))
  return (value.astimezone(__import__('zoneinfo').ZoneInfo('Asia/Shanghai')) if value.tzinfo else value).date()
 except ValueError:ds_fail('DATE_INVALID')
def ds_compute(raw,name,options,mapping,rule,period):
 sheets,meta=ds_load(raw,name,options)
 if not re.fullmatch(r'\d{4}-\d{2}',period):ds_fail('PERIOD_INVALID')
 try:start=dt.date.fromisoformat(period+'-01');end=dt.date(start.year+int(start.month==12),start.month%12+1,1)
 except ValueError:ds_fail('PERIOD_INVALID')
 sheet=mapping.get('sheet')
 if sheet not in sheets:ds_fail('DATA_SHEET_REQUIRED')
 header=mapping.get('headerRow');columns=mapping.get('fields',{})
 if not isinstance(header,int) or not 1<=header<=25:ds_fail('DATA_HEADER_INVALID')
 for field in ['date','weight','id','node','source','category']:
  if not isinstance(columns.get(field),int) or isinstance(columns[field],bool) or not 0<=columns[field]<DS_MAX_COLS:ds_fail('DATA_MAPPING_REQUIRED:'+field)
 if len(set(columns.values()))!=len(columns):ds_fail('DATA_MAPPING_REPEATED_COLUMN')
 conversion={k:Decimal(str(v)) for k,v in rule['unitFactors'].items()};scale=rule['precision'];quantum=Decimal(1).scaleb(-scale)
 rows=[];issues=[];total=Decimal(0);groups={'category':collections.defaultdict(Decimal),'source':collections.defaultdict(Decimal),'month':collections.defaultdict(Decimal)};counts=collections.Counter();seen={};trends=collections.defaultdict(Decimal)
 formula={(x['row'],x['column']-1):x for x in meta['formulaErrors'] if x['sheet']==sheet}
 rawCount=0
 for n,values in sheets[sheet]:
  if n<=header:continue
  if not any(values):continue
  rawCount+=1
  if rawCount>DS_MAX_ROWS:ds_fail('DATA_ROW_LIMIT_50000')
  item={'sheet':sheet,'row':n,'outcome':'excluded','reason':'','original':values}
  def issue(code,severity='blocker',field=None):
   issues.append({'sheet':sheet,'row':n,'field':field,'code':code,'severity':severity,'handling':'not_counted' if severity=='blocker' else 'excluded'});item['reason']=code
  def get(field):
   i=columns.get(field)
   return values[i] if isinstance(i,int) and i<len(values) else ''
  # Summary/header rows are explicitly accounted for, never silently counted twice.
  if any(re.fullmatch(r'(?:合计|总计|小计|汇总|total|subtotal)',ds_clean(v),re.I) for v in values[:min(4,len(values))]):
   issue('SUMMARY_ROW','warning');rows.append(item);counts['SUMMARY_ROW']+=1;continue
  if ds_key(get('date')) in [ds_key(a) for a in DS_FIELDS['date']] and ds_key(get('weight')) in [ds_key(a) for a in DS_FIELDS['weight']]:
   issue('REPEATED_HEADER','warning');rows.append(item);counts['REPEATED_HEADER']+=1;continue
  problems=[]
  for field in ['date','weight','id','node','source','category']:
   if not get(field):problems.append(('REQUIRED_MISSING',field))
   if (n,columns[field]) in formula:problems.append(('FORMULA_VALUE_UNVERIFIED',field))
  date=None;weight=None
  try:date=ds_date(get('date'))
  except Exception:problems.append(('DATE_INVALID','date'))
  weightText=get('weight');suffix=re.fullmatch(r'([+-]?[0-9][0-9,.]*(?:[eE][+-]?[0-9]+)?)\s*([^0-9\s.,+-]+)',weightText)
  inlineUnit=suffix[2] if suffix else ''
  unit=get('unit') or inlineUnit or mapping.get('defaultUnit') or ''
  if suffix:weightText=suffix[1]
  if inlineUnit and get('unit') and inlineUnit!=get('unit'):problems.append(('UNIT_INCOMPATIBLE','unit'))
  if not unit:problems.append(('UNIT_MISSING','unit'))
  elif unit not in conversion:problems.append(('UNIT_INCOMPATIBLE','unit'))
  else:
   try:
    val=Decimal(re.sub(r',(?=\d{3}(?:\D|$))','',weightText))
    if not val.is_finite() or abs(val)>Decimal('1e15'):raise InvalidOperation
    weight=(val*conversion[unit]).quantize(quantum,rounding=ROUND_HALF_UP)
    if weight<0:problems.append(('NEGATIVE_WEIGHT','weight'))
   except Exception:problems.append(('WEIGHT_INVALID','weight'))
  node=rule['nodeAliases'].get(get('node'));source=rule['sourceAliases'].get(get('source'));category=rule['categoryAliases'].get(get('category'))
  if not node:problems.append(('NODE_UNKNOWN','node'))
  if not source:problems.append(('OBJECT_UNKNOWN','source'))
  if not category:problems.append(('OBJECT_UNKNOWN','category'))
  if rule.get('allowedOrganizations'):
   org=rule.get('organizationAliases',{}).get(get('organization'))
   if not org or org not in rule['allowedOrganizations']:problems.append(('ORGANIZATION_OUTSIDE_SCOPE','organization'))
  status=get('status');statusKind='active'
  if status:
   statusKind=rule['statusAliases'].get(status)
   if not statusKind:problems.append(('STATUS_UNKNOWN','status'))
   if statusKind=='reversal':problems.append(('REVERSAL_REQUIRES_REVIEW','status'))
  item.update({'id':get('id'),'date':date.isoformat() if date else None,'node':node,'source':source,'category':category,'unit':unit,'inputWeight':get('weight'),'weightKg':str(weight) if weight is not None else None})
  if problems:
   for code,field in dict.fromkeys(problems):issue(code,'blocker',field)
   item['outcome']='invalid';counts['INVALID']+=1;rows.append(item);continue
  fingerprint=(item['date'],node,source,category,str(weight),statusKind)
  identifier=get('id')
  if identifier in seen:
   if seen[identifier]!=fingerprint:issue('DUPLICATE_CONFLICT');item['outcome']='invalid';counts['INVALID']+=1
   elif rule['duplicateRule']=='identical_first':issue('DUPLICATE_IDENTICAL','warning');counts['DUPLICATE_IDENTICAL']+=1
   else:issue('DUPLICATE_BLOCK');item['outcome']='invalid';counts['INVALID']+=1
   rows.append(item);continue
  seen[identifier]=fingerprint
  if statusKind=='cancelled':issue('CANCELLED_RECORD','warning');counts['CANCELLED_RECORD']+=1;rows.append(item);continue
  if node not in rule['includeNodes']:issue('OTHER_NODE','warning');counts['OTHER_NODE']+=1;rows.append(item);continue
  trends[date.strftime('%Y-%m')]+=weight
  if not start<=date<end:issue('OUTSIDE_PERIOD','warning');counts['OUTSIDE_PERIOD']+=1;rows.append(item);continue
  item['outcome']='included';item['reason']='INCLUDED';total+=weight;groups['source'][source]+=weight;groups['category'][category]+=weight;counts['INCLUDED']+=1;rows.append(item)
 blockers=sum(1 for x in issues if x['severity']=='blocker');valid=blockers==0
 def grouped(values):return [{'name':k,'weightKg':format(v,'.'+str(scale)+'f'),'percent':format(v/total*100 if total else Decimal(0),'.2f') if total else None} for k,v in sorted(values.items())]
 return {'status':'validated' if valid else 'blocked','completeScan':True,'rowCount':rawCount,'includedCount':counts['INCLUDED'],'excludedCount':rawCount-counts['INCLUDED']-counts['INVALID'],'invalidCount':counts['INVALID'],'blockerCount':blockers,'warningCount':len(issues)-blockers,'counts':dict(counts),'summary':{'weightKg':format(total,'.'+str(scale)+'f'),'weightTon':format(total/Decimal(1000),'.'+str(scale+3)+'f'),'byCategory':grouped(groups['category']),'bySource':grouped(groups['source']),'trend':[{'month':k,'weightKg':str(v)} for k,v in sorted(trends.items())]} if valid else None,'issues':issues,'rows':rows,'period':period,'timeBasis':'business_date_local_Asia/Shanghai','rounding':'per_record_HALF_UP_'+str(scale),'limitations':['No production/price/cost/contract/transport inputs: no unit-production, savings or optimal transport inference.','Trend covers only supplied valid records and configured nodes, not proof of complete enterprise history.']}
`;
