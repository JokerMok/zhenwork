// RC2 uses per-agent MCP connections; capability credentials stay in process memory.
if(!/^[a-f0-9]{64}$/.test(process.env.WORKSPACE_TOOL_TOKEN||''))throw Error('MissingRuntimeCapability');
process.argv=[process.execPath,'/opt/harness/apps/cli/lib/bin.js','--profile','sdk','--patch','/opt/workspace/runtime.patch.yml'];
const {runCli}=await import('/opt/harness/apps/cli/lib/bin.js');await runCli();
