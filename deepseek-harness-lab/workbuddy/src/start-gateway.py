"""Create only lab-owned networks and a private gateway; never read the Ark secret in this launcher."""
import pathlib,subprocess,json,os
w=pathlib.Path(__file__).resolve().parents[1];lab=w.parent
for suffix in ['a','b']:
 name='wb-alpha-'+suffix
 r=subprocess.run(['docker','network','inspect',name],capture_output=True,text=True)
 if r.returncode==0:
  if json.loads(r.stdout)[0]['Labels'].get('workbuddy.alpha')!='boundary':raise RuntimeError('foreign network collision')
 else:subprocess.run(['docker','network','create','--internal','--label','workbuddy.alpha=boundary',name],check=True,stdout=subprocess.DEVNULL)
g=w/'evidence/gateway';g.mkdir(exist_ok=True)
args=['docker','run','-d','--name','wb-alpha-gateway','--label','workbuddy.alpha=boundary','--network','bridge','--read-only','--cap-drop=ALL','--security-opt','no-new-privileges','--user',f'{os.getuid()}:{os.getgid()}','--memory','256m','--pids-limit','64','--tmpfs','/tmp:rw,noexec,nosuid,size=16m']
for p,target in [(lab/'evidence/harness-home/.credentials.yaml','/secret/credentials.yaml'),(w/'.state/gateway.json','/config/gateway.json'),(w/'.state/gateway-tokens.json','/config/gateway-tokens.json')]:args+=['--mount',f'type=bind,src={p},dst={target},readonly']
args+=['--mount',f'type=bind,src={g},dst=/evidence','workbuddy-alpha-gateway:boundary']
subprocess.run(args,check=True,stdout=subprocess.DEVNULL)
for suffix in ['a','b']:subprocess.run(['docker','network','connect','--alias','model-gateway','wb-alpha-'+suffix,'wb-alpha-gateway'],check=True)
print('Gateway started on private container networks; no published ports.')
