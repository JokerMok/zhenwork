import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
export const root=path.dirname(fileURLToPath(import.meta.url));
export const digest=x=>createHash('sha256').update(typeof x==='string'||Buffer.isBuffer(x)?x:JSON.stringify(x)).digest('hex');
export async function buildBundle(requiredTools=[]){
 if(!Array.isArray(requiredTools)||requiredTools.some(id=>!/^[a-f0-9-]{36}$/i.test(id)))throw Error('Real authorized tool UUIDs required');
 let source=await fs.readFile(path.join(root,'SKILL.md'),'utf8');source=source.replace('requiredTools: []','requiredTools: '+JSON.stringify(requiredTools));
 const files=[];
 const walk=async dir=>{for(const e of (await fs.readdir(path.join(root,dir),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){if(e.name.startsWith('.')||e.name==='__pycache__')continue;const relative=dir+'/'+e.name;if(e.isSymbolicLink())throw Error('No package symlinks');if(e.isDirectory())await walk(relative);else{const bytes=await fs.readFile(path.join(root,relative));const binary=/\.xlsx$/.test(relative);const content=binary?bytes.toString('base64'):bytes.toString('utf8');files.push({path:relative,content,encoding:binary?'base64':'utf8',executable:relative.startsWith('scripts/')&&relative.endsWith('.py'),sha256:digest(bytes)});}}};
 // Runtime methods/config first; large upstream catalog remains separately readable.
 for(const name of ['methods.md','company.json','preferences.json']){const content=await fs.readFile(path.join(root,'references',name),'utf8');files.push({path:'references/'+name,content,encoding:'utf8',executable:false,sha256:digest(content)});}
 for(const dir of ['references','scripts','templates','examples'])await walk(dir);
 for(const name of ['LICENSE','README.md']){const content=await fs.readFile(path.join(root,name),'utf8');files.push({path:name,content,encoding:'utf8',executable:false,sha256:digest(content)});}
 return{name:'企业固危废数据专员 · 标准工作方法',description:'[waste-specialist:v1] 原六类方法及产废强度、费用变化分析；复用已核对结果/可复制个人配置。',config:{source,files:files.filter((x,i,a)=>a.findIndex(y=>y.path===x.path)===i)}};
}
