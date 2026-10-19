// Bind only this instance's capability credential through the upstream's explicit MCP env seam.
// The Provider credential is never present here. Keep the upstream subprocess scrubber unchanged.
import fs from 'node:fs';import path from 'node:path';
const token=process.env.WORKSPACE_TOOL_TOKEN;if(!/^[a-f0-9]{64}$/.test(token||''))throw Error('MissingRuntimeCapability');
const template=fs.readFileSync('/opt/workspace/runtime.patch.yml','utf8');const marker='__RUNTIME_CAPABILITY_TOKEN__';if(template.split(marker).length!==2)throw Error('InvalidRuntimeTemplate');
const dir=fs.mkdtempSync('/tmp/workspace-config-'),file=path.join(dir,'runtime.patch.yml');fs.chmodSync(dir,0o700);fs.writeFileSync(file,template.replace(marker,JSON.stringify(token)),{flag:'wx',mode:0o600});
process.once('exit',()=>{try{fs.unlinkSync(file);fs.rmdirSync(dir);}catch{/* Container tmpfs is destroyed on replacement. */}});
process.argv=[process.execPath,'/opt/harness/apps/cli/lib/bin.js','--profile','sdk','--patch',file];const {runCli}=await import('/opt/harness/apps/cli/lib/bin.js');await runCli();
