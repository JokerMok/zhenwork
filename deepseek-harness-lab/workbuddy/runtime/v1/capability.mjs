export async function capability(tool,args={},extra={}){
 const response=await fetch('http://model-gateway:8081/v1/capability',{method:'POST',headers:{authorization:'Bearer '+process.env.WORKSPACE_TOOL_TOKEN,'content-type':'application/json'},body:JSON.stringify({tool,args,...extra}),signal:AbortSignal.timeout(15000)});
 const result=await response.json();if(!response.ok)throw Error(['PermissionDenied','KnowledgeError','ToolError','RateLimit'].includes(result.error?.code)?result.error.code:'ToolError');return result;
}
