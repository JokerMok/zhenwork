export const PARSER_PYTHON = String.raw`import csv,datetime as dt,io,zipfile,re,hashlib,collections,calendar,ast
from decimal import Decimal,InvalidOperation,ROUND_HALF_UP
DS_MAX_ROWS=50000
DS_MAX_COLS=64
DS_MAX_SHEETS=10
DS_MAX_BYTES=20*1024*1024
DS_FIELDS={'date':['业务日期','产废日期','产生日期','发生日期','日期'],'weight':['净重','重量','产废重量','产生重量','净重kg','净重(kg)','重量(kg)','产生量','数量'],'unit':['重量单位','计量单位','单位'],'id':['业务单号','记录编号','业务记录编号','记录ID','单号','流水号'],'node':['业务节点','节点','业务类型','环节'],'source':['所属车间','车间','来源部门','产废来源','部门'],'category':['废物类别','废物代码','类别','危废代码'],'status':['记录状态','状态'],'organization':['业务单位','企业名称','企业'],'wasteName':['废物名称','危废名称']}
def ds_fail(code):raise ValueError(code)
def ds_clean(x):
 if x is None:return ''
 if isinstance(x,(dt.datetime,dt.date)):return x.isoformat()
 value=str(x).strip()
 if len(value)>4000:ds_fail('DATA_CELL_LIMIT_4000')
 return value
def ds_key(x):return re.sub(r'[\s\[\]（）()_\-]','',ds_clean(x)).lower()
def ds_load(raw,name,options):
 if not raw or len(raw)>DS_MAX_BYTES:ds_fail('DATA_FILE_LIMIT_20MB')
 if name.lower().endswith('.csv'):
  enc=options.get('encoding');encs=[enc] if enc else (['utf-8-sig'] if raw.startswith(b'\xef\xbb\xbf') else ['utf-8','gb18030'])
  text=None
  for e in encs:
   if e not in ['utf-8','utf-8-sig','gb18030']:ds_fail('DATA_ENCODING_UNSUPPORTED')
   try:text=raw.decode(e,errors='strict');enc=e;break
   except UnicodeDecodeError:pass
  if text is None or '\x00' in text:ds_fail('DATA_ENCODING_REQUIRED')
  delimiter=options.get('delimiter')
  if delimiter not in [None,',',';','\t']:ds_fail('DATA_DELIMITER_INVALID')
  if not delimiter:
   try:delimiter=csv.Sniffer().sniff(text[:32000],delimiters=',;\t').delimiter
   except csv.Error:delimiter=','
  rows=[]
  reader=csv.reader(io.StringIO(text,newline=''),delimiter=delimiter);previous=0
  for count,row in enumerate(reader,1):
   if count>DS_MAX_ROWS+30 or len(row)>DS_MAX_COLS:ds_fail('DATA_ROW_COLUMN_LIMIT')
   n=previous+1;previous=reader.line_num
   rows.append((n,[ds_clean(v) for v in row]))
  return {'CSV':rows},{'encoding':enc,'delimiter':delimiter,'formulaErrors':[]}
 if not name.lower().endswith('.xlsx'):ds_fail('DATA_FORMAT_XLSX_CSV_ONLY')
 with zipfile.ZipFile(io.BytesIO(raw)) as z:
  entries=z.infolist()
  if len(entries)>2000 or sum(x.file_size for x in entries)>100*1024*1024:ds_fail('DATA_ZIP_LIMIT_100MB')
  if any(x.flag_bits&1 or '..' in x.filename.split('/') or x.filename.startswith('/') or 'vbaproject' in x.filename.lower() or x.filename.startswith('xl/externalLinks/') for x in entries):ds_fail('DATA_UNSAFE_WORKBOOK')
 import openpyxl
 wb=openpyxl.load_workbook(io.BytesIO(raw),read_only=True,data_only=False,keep_links=False)
 if len(wb.worksheets)>DS_MAX_SHEETS:ds_fail('DATA_SHEET_LIMIT_10')
 chosen=options.get('sheet');sheets={};errors=[]
 if chosen and chosen not in wb.sheetnames:ds_fail('DATA_SHEET_UNKNOWN')
 for ws in wb:
  if chosen and ws.title!=chosen:continue
  if (ws.max_row or 0)>DS_MAX_ROWS+30 or (ws.max_column or 0)>DS_MAX_COLS:ds_fail('DATA_ROW_COLUMN_LIMIT')
  ws.reset_dimensions()
  rows=[];formula={};cells={}
  # read_only iteration is bounded; formulas reference only loaded input cells.
  from openpyxl.utils.cell import get_column_letter
  for rIndex,row in enumerate(ws.iter_rows(),1):
   if rIndex>DS_MAX_ROWS+30 or len(row)>DS_MAX_COLS:ds_fail('DATA_ROW_COLUMN_LIMIT')
   vals=[]
   for cIndex,c in enumerate(row,1):
    coordinate=get_column_letter(cIndex)+str(rIndex);v=c.value
    if getattr(c,'data_type',None)=='f':formula[coordinate]=v;v=None
    if c.value is not None:cells[coordinate]=c.value
    vals.append(ds_clean(v))
   rows.append((rIndex,vals))
  cache={};stack=[]
  def cell(ref):
   ref=ref.replace('$','').upper()
   if ref in cache:return cache[ref]
   if len(stack)>=32 or ref in stack:ds_fail('FORMULA_CIRCULAR_OR_TOO_DEEP')
   v=cells.get(ref)
   if v is None or isinstance(v,bool):ds_fail('FORMULA_VALUE_UNVERIFIED')
   if isinstance(v,str) and v.startswith('='):
    stack.append(ref)
    try:value=FormulaParser(v,cell,ran).parse()
    finally:stack.pop()
   else:value=Decimal(str(v))
   if not value.is_finite():ds_fail('FORMULA_VALUE_UNVERIFIED')
   cache[ref]=value;return value
  def ran(a,b):
   from openpyxl.utils.cell import coordinate_to_tuple,get_column_letter
   ra,ca=coordinate_to_tuple(a);rb,cb=coordinate_to_tuple(b)
   if (rb-ra+1)*(cb-ca+1)>50000:ds_fail('FORMULA_RANGE_LIMIT')
   return [cell(get_column_letter(c)+str(r)) for r in range(ra,rb+1) for c in range(ca,cb+1)]
  for ref in formula:
   from openpyxl.utils.cell import coordinate_to_tuple
   row,col=coordinate_to_tuple(ref)
   try:rows[row-1][1][col-1]=str(cell(ref))
   except Exception:rows[row-1][1][col-1]='';errors.append({'sheet':ws.title,'row':row,'column':col,'code':'FORMULA_VALUE_UNVERIFIED','severity':'blocker'})
  sheets[ws.title]=rows
 wb.close()
 return sheets,{'encoding':None,'delimiter':None,'formulaErrors':errors}
def ds_structure(raw,name,options):
 sheets,meta=ds_load(raw,name,options);items=[]
 for title,rows in sheets.items():
  candidates=[]
  for n,values in rows[:25]:
   keys=[ds_key(x) for x in values];matches=sum(1 for aliases in DS_FIELDS.values() if any(ds_key(a) in keys for a in aliases))
   candidates.append((matches,n,values))
  candidates.sort(key=lambda x:(-x[0],x[1]))
  header=options.get('headerRow') or (candidates[0][1] if candidates and candidates[0][0]>=2 else 1)
  columns=next((v for n,v in rows if n==header),[]);width=len(columns)
  if not columns or len(set(ds_key(x) for x in columns if x))!=len([x for x in columns if x]):
   columns=[x or '列'+str(i+1) for i,x in enumerate(columns)]
  mapping={};ambiguities=[]
  if len(set(ds_key(x) for x in columns if x))!=len([x for x in columns if x]):ambiguities.append('duplicate_headers')
  for field,aliases in DS_FIELDS.items():
   indices=[i for i,c in enumerate(columns) if ds_key(c) in [ds_key(a) for a in aliases] or field=='weight' and any(ds_key(c)==ds_key(a)+u for a in ['净重','重量','产生重量','产废重量'] for u in ['kg','吨','t'])]
   if len(indices)==1:mapping[field]=indices[0]
   elif len(indices)>1:ambiguities.append(field)
  inferred=None
  if 'weight' in mapping:
   h=columns[mapping['weight']]
   if re.search(r'(?i)(?:\(|（|\[)?kg(?:\)|）|\])?$',h):inferred='kg'
   elif re.search(r'(?:吨|\(t\)|（t）)$',h,re.I):inferred='吨'
  active=[(n,v) for n,v in rows if n>header and any(v)]
  if len(active)>DS_MAX_ROWS:ds_fail('DATA_ROW_LIMIT_50000')
  items.append({'name':title,'headerRow':header,'headerCandidates':[{'row':n,'score':score} for score,n,_ in candidates[:3]],'columns':columns,'columnTypes':[('number' if vals and all(re.fullmatch(r'[+-]?[0-9]+(?:\.[0-9]+)?',v) for v in vals) else 'text_or_date') for i in range(len(columns)) for vals in [[v[i] for _,v in rows if len(v)>i and v[i]][1:101]]],'rowCount':len(active),'mapping':mapping,'unitHint':inferred,'ambiguities':ambiguities,'sample':[{'row':n,'values':v} for n,v in active[:12]],'sampleIsPreviewOnly':True})
 return {'sheets':items,'meta':meta,'budget':{'fileBytes':DS_MAX_BYTES,'rowsPerSheet':DS_MAX_ROWS,'columns':DS_MAX_COLS,'sheets':DS_MAX_SHEETS,'seconds':60},'sha256':hashlib.sha256(raw).hexdigest()}
`;
