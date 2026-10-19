"""Reuse the stopped Alpha runtimes, isolate all new BFF/gateway evidence."""
import pathlib,subprocess,json,os,shutil
r=pathlib.Path(__file__).resolve().parents[3];lab=r.parent;d=r/'.research/spike-alpha';d.mkdir(exist_ok=True)
for name in ['src','.state','evidence']:(d/name).mkdir(exist_ok=True)
for name in ['bff.mjs','runtime-client.mjs']:shutil.copyfile(r/'src'/name,d/'src'/name)
shutil.copyfile(r/'.state/users.json',d/'.state/users.json');os.chmod(d/'.state/users.json',0o600)
g=r/'evidence/v1/reuse-r1/gateway';g.mkdir(exist_ok=True)
name='wb-v1-spike-gateway';exists=subprocess.run(['docker','inspect',name],capture_output=True).returncode==0
if not exists:
 args=['docker','run','-d','--name',name,'--label','workbuddy.stage=reuse-r1','--network','bridge','--read-only','--cap-drop=ALL','--security-opt','no-new-privileges','--user',f'{os.getuid()}:{os.getgid()}','--memory','256m','--pids-limit','64','--tmpfs','/tmp:rw,noexec,nosuid,size=16m']
 for p,target in [(lab/'evidence/harness-home/.credentials.yaml','/secret/credentials.yaml'),(r/'.state/gateway.json','/config/gateway.json'),(r/'.state/gateway-tokens.json','/config/gateway-tokens.json')]:args+=['--mount',f'type=bind,src={p},dst={target},readonly']
 args+=['--mount',f'type=bind,src={g},dst=/evidence','workbuddy-alpha-gateway:boundary'];subprocess.run(args,check=True,stdout=subprocess.DEVNULL)
 for suffix in ['a','b']:subprocess.run(['docker','network','connect','--alias','model-gateway','wb-alpha-'+suffix,name],check=True)
for n in ['wb-alpha-a','wb-alpha-b',name]:subprocess.run(['docker','start',n],check=True,stdout=subprocess.DEVNULL)
print('Synthetic Alpha runtime reuse prepared; old gateway remains stopped, new logs isolated; no public container ports.')
