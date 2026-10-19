import {createHash} from 'node:crypto';
type Docker=(args:string[])=>Promise<string>;
export function cidrRange(cidr:string):[number,number]{const [ip,bits]=cidr.split('/'),parts=ip!.split('.').map(Number),n=Number(bits);if(parts.length!==4||parts.some(x=>!Number.isInteger(x)||x<0||x>255)||!Number.isInteger(n)||n<0||n>32)throw Error('InvalidSubnet');const address=parts.reduce((a,b)=>(a*256+b),0),size=2**(32-n),start=Math.floor(address/size)*size;return[start,start+size-1];}
export function runtimeSubnet(base:string,index:number){const [start,end]=cidrRange(base);if(!base.endsWith('/16')||end-start!==65535||!(start>=167772160&&end<=184549375||start>=2886729728&&end<=2887778303||start===3232235520))throw Error('Private16SubnetRequired');const address=start+((index%4096+4096)%4096)*16;return[24,16,8,0].map(b=>Math.floor(address/2**b)%256).join('.')+'/28';}
/** Tiny explicit subnets avoid consuming Docker's finite default /16 pool per employee. */
export async function createRuntimeNetwork(docker:Docker,name:string,owner:string,prefix:string,base:string){
 const seed=createHash('sha256').update(prefix+':'+owner).digest().readUInt32BE(0)%4096;
 for(let retry=0;retry<3;retry++){
  const ids=(await docker(['network','ls','-q'])).split('\n').filter(Boolean);
  const networks=ids.length?JSON.parse(await docker(['network','inspect',...ids])):[];
  const occupied:[number,number][]=networks.flatMap((n:any)=>(n.IPAM?.Config||[]).filter((c:any)=>typeof c.Subnet==='string'&&!c.Subnet.includes(':')).map((c:any)=>cidrRange(c.Subnet)));
  let selected:string|undefined;for(let i=0;i<4096;i++){const candidate=runtimeSubnet(base,seed+i),[lo,hi]=cidrRange(candidate);if(!occupied.some(([a,b])=>lo<=b&&a<=hi)){selected=candidate;break;}}
  if(!selected)throw Error('RateLimit');
  try{await docker(['network','create','--internal','--subnet',selected,'--label','workspace.product=v1','--label','workspace.deployment='+prefix,'--label','workspace.owner='+owner,name]);return;}
  catch(e){if(!String((e as {stderr?:string}).stderr||'').includes('overlap'))throw e;}
 }
 throw Error('RateLimit');
}
