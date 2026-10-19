"""Lab-only per-user containers. Bind only that user's data and immutable wrapper code."""
import pathlib,json,subprocess,os,secrets
w=pathlib.Path(__file__).resolve().parents[1];state=w/'.state';tokens=json.loads((state/'gateway-tokens.json').read_text());cfg=json.loads((state/'gateway.json').read_text());canaries={}
for suffix in ['a','b']:
 if subprocess.run(['docker','container','inspect','wb-alpha-'+suffix],capture_output=True).returncode==0:raise RuntimeError('Existing lab Runtime; use docker start, not reprovision')
for suffix in ['a','b']:
 owner='user_'+suffix; root=state/owner
 for d in ['workspace','home','knowledge','config']:(root/d).mkdir(parents=True,exist_ok=True)
 secret=suffix.upper()+'_ONLY_SECRET_'+secrets.token_hex(12);kb='KNOWLEDGE_'+suffix.upper()+'_CANARY_'+secrets.token_hex(12);session='SESSION_'+suffix.upper()+'_CANARY_'+secrets.token_hex(12)
 canaries[owner]={'workspace':secret,'knowledge':kb,'session':session,'hostWorkspace':str(root/'workspace')}
 (root/'workspace/canary.txt').write_text(secret+'\n');(root/'workspace/input.txt').write_text('SYNTHETIC_FILE_'+suffix.upper()+'\n')
 docs=[{'id':f'{suffix}-doc-{i}','title':f'Synthetic {suffix} policy {i}','owner':owner,'tenant':'alpha','acl':[owner],'text':kb if i==0 else f'Synthetic policy {i} for {owner}.'}for i in range(4)]
 (root/'knowledge/documents.json').write_text(json.dumps(docs))
 patch='''- id: sdk-jsonrpc-server
  disabled: true
- id: session-log-deepseek
  disabled: true
- id: session-telemetry-otel
  disabled: true
- id: plugin-manager
  disabled: true
- id: llm-pi-ai
  config:
    providers:
      workbuddy-gateway:
        api: openai-completions
        baseURL: http://model-gateway:8081/v1
        apiKeyEnv: WB_GATEWAY_TOKEN
        retryPolicy:
          mode: normal
          maxRetries: 0
        models:
          - id: MODEL
            contextWindow: 32000
            maxTokens: 2048
- id: skill-filesystem
  config:
    includeDefaultRoots: false
    customSkillDirs: [/skills]
- insert:
    - id: workbuddy-boundary-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: boundary
        transport: stdio
        command: /usr/local/bin/node
        args: [/alpha/knowledge-mcp.mjs]
        env:
          WB_OWNER: OWNER
        cwd: /workspace
        failOnStartupError: true
    - id: workbuddy-boundary-bridge
      name: /alpha/runtime-bridge.mjs
'''.replace('MODEL',cfg['model']).replace('OWNER',owner)
 (root/'config/runtime.patch.yml').write_text(patch)
 name='wb-alpha-'+suffix
 args=['docker','run','-d','--name',name,'--label','workbuddy.alpha=boundary','--network',name,'--read-only','--cap-drop=ALL','--security-opt','no-new-privileges','--user',f'{os.getuid()}:{os.getgid()}','--memory','2g','--cpus','2','--pids-limit','128','--tmpfs','/tmp:rw,exec,nosuid,size=128m','--env','WB_OWNER='+owner,'--env','WB_MODEL='+cfg['model'],'--env','WB_GATEWAY_TOKEN='+tokens[owner],'--env','DSH_AGENTS_HOME=/empty-agents']
 for p,target,ro in [(w/'src','/alpha',True),(w/'fixtures/skills','/skills',True),(root/'workspace','/workspace',False),(root/'home','/data/home',False),(root/'knowledge','/knowledge',True),(root/'config','/config',True)]:args+=['--mount',f'type=bind,src={p},dst={target}'+(',readonly' if ro else '')]
 args+=['workbuddy-alpha-runtime:ddefc45']
 subprocess.run(args,check=True,stdout=subprocess.DEVNULL)
 for p in root.rglob('*'):
  if p.is_file():p.chmod(0o600)
 print(name+' provisioned; no host ports or shared data.')
(state/'canaries.json').write_text(json.dumps(canaries,indent=2));(state/'canaries.json').chmod(0o600)
