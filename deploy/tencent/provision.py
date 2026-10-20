#!/usr/bin/env python3
"""Provision only the independent pilot accounts and one authorized model via RC2 APIs."""
import string
import json,pathlib,secrets,urllib.request,urllib.error
def account_password():
 while True:
  value=''.join(secrets.choice(string.ascii_letters+string.digits) for _ in range(8))
  if any(c.isalpha() for c in value) and any(c.isdigit() for c in value):return value

C=pathlib.Path('/srv/apps/zhenwork/shared/config');P=C/'pilot-credentials.json';S=json.loads(P.read_text());origin='https://zhenwork.shizibandu.icu';base='http://127.0.0.1:18890'
def req(route,body=None,cookie='',method=None,require=True):
 h={'Content-Type':'application/json','Origin':origin,'clientid':S['clientId']}
 if cookie:h['Cookie']=cookie
 r=urllib.request.Request(base+route,data=json.dumps(body).encode() if body is not None else None,headers=h,method=method or ('POST' if body is not None else 'GET'))
 try:
  with urllib.request.urlopen(r,timeout=60) as f:result=json.load(f); cookies=f.headers.get_all('Set-Cookie') or []
 except urllib.error.HTTPError as e:
  result=json.load(e);cookies=[]
 if require and result.get('code')!=200:raise RuntimeError(f"RC2 {route}: {result.get('code')} {result.get('msg','')}")
 return result,cookies
def login(a):
 r,c=req('/auth/login',{'username':a['username'],'password':a['password'],'clientId':S['clientId'],'grantType':'password'})
 if len(c)!=1:raise RuntimeError('Expected one secure RC2 session cookie')
 return c[0].split(';')[0],r['data']
def save():
 p=P.with_suffix('.tmp');p.write_text(json.dumps(S,indent=2)+'\n');p.chmod(0o600);p.replace(P)
def rows(r):
 d=r.get('data',{});return d.get('rows',[]) if isinstance(d,dict) else d
admin=S['accounts'][0];a,_=login(admin);info=req('/system/user/getInfo',cookie=a)[0]['data']['user'];admin['userId']=str(info['userId'])
roles=rows(req('/system/role/list?pageNum=1&pageSize=100',cookie=a)[0]);role=next(x for x in roles if x['roleKey']=='workspace_employee')
existing=rows(req('/system/user/list?pageNum=1&pageSize=100',cookie=a)[0])
for emp in S['accounts'][1:]:
 if not any(x['userName']==emp['username'] for x in existing):
  req('/system/user',{'userName':emp['username'],'nickName':'试点员工 '+emp['username'][-1].upper(),'deptId':info['deptId'],'status':'0','userType':'sys_user','gender':'2','roleIds':[role['roleId']],'postIds':[],'password':emp['password']},a)
 e,d=login(emp)
 if d.get('mustChangePassword'):
  new=account_password()
  req('/system/user/profile/updatePwd',{'oldPassword':emp['password'],'newPassword':new},e,'PUT')
  emp['password']=new;save();e,d=login(emp)
  if d.get('mustChangePassword'):raise RuntimeError('Employee password setup incomplete')
 emp['userId']=str(req('/system/user/getInfo',cookie=e)[0]['data']['user']['userId'])
 req('/auth/logout',{},e)
save()
M=json.loads((C/'model-bootstrap.json').read_text())
providers=req('/ai/admin/providers',cookie=a)[0]['data'];provider=next((p for p in providers if p['name']=='ZhenWork Pilot'),None)
if not provider:
 provider=req('/ai/admin/providers',{'name':'ZhenWork Pilot','providerType':M['providerType'],'baseUrl':M['baseUrl'],'protocol':'OPENAI_CHAT','secret':M['secret'],'enabled':True,'timeoutSeconds':60,'retryCount':0},a)[0]['data']
models=req('/ai/admin/models',cookie=a)[0]['data'];model=next((m for m in models if m['name']=='默认办公模型'),None)
if not model:
 model=req('/ai/admin/models',{'providerId':str(provider['id']),'code':M['code'],'name':'默认办公模型','enabled':True,'streaming':True,'tools':True,'vision':False,'contextWindow':128000,'maxOutputTokens':16384,'defaultParameters':{},'costConfig':{}},a)[0]['data']
for account in S['accounts']:req('/ai/admin/models/'+str(model['id'])+'/grants',{'subjectType':'USER','subjectId':account['userId']},a)
S['modelId']=str(model['id']);save()
brand=req('/ai/brand',cookie=a)[0]['data'];req('/ai/brand',{**brand,'productName':'ZhenWork','companyName':'臻作','loginTitle':'登录臻作工作台','loginSubtitle':'','expectedVersion':brand['version']},a,'PUT')
probe=req('/ai/admin/models/'+str(model['id'])+'/tests',{},a)[0]['data']
req('/auth/logout',{},a)
print(json.dumps({'accounts':[x['username'] for x in S['accounts']],'modelId':S['modelId'],'modelProbe':probe.get('status'),'probeError':probe.get('error_code'),'credentials':str(P)},ensure_ascii=False))
if probe.get('status')!='PASS':raise RuntimeError('Actual model provider probe failed')
