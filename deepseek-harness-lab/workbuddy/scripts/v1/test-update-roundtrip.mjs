import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
const state=path.resolve(process.env.DEPLOY_STATE||'.state/p8-final');
const reportFile=process.env.UPDATE_REPORT||'evidence/v1/p8/update-roundtrip-final.json';
const before=JSON.parse(fs.readFileSync(path.join(state,'deployment.json')));
const managerBefore=JSON.parse(fs.readFileSync(path.join(state,'manager.json')));
const originalManifest=JSON.parse(fs.readFileSync(path.join(state,'candidate-manifest.json')));
const checks=[];const nonce=randomUUID();const tags=[];
function docker(args,extra={}){return execFileSync('docker',args,{encoding:'utf8',...extra});}
function run(mode,args=[]){return execFileSync(process.execPath,['scripts/ops/update.mjs',mode,'--state',state,...args],{encoding:'utf8'});}
function variant(name,digest){const tag=`workspace-update-test-${name}:${nonce}`;const id=docker(['create',digest]).trim();try{docker(['commit','--change',`LABEL workspace.update-test="${nonce}"`,id,tag]);}finally{docker(['rm',id]);}tags.push(tag);return JSON.parse(docker(['image','inspect',tag]))[0].Id;}
function check(name,fn){fn();checks.push({name,status:'PASS'});}
async function modelProbe(expectedDigest,label){
 const account=JSON.parse(fs.readFileSync(path.join(state,'test-users.json'))).a;let cookie='';
 async function req(route,body){const r=await fetch(before.origin+'/api'+route,{method:body===undefined?'GET':'POST',headers:{origin:before.origin,cookie,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});if(r.headers.getSetCookie().length)cookie=r.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');return {status:r.status,data:await r.json()};}
 assert.equal((await req('/auth/sign-in/email',{email:account.email,password:account.password})).status,200);
 const aid=(await req('/assistants')).data[0].id;const sid=(await req('/sessions',{assistantId:aid,title:'升级回滚验收 '+label})).data.id;assert.ok(sid);
 assert.equal((await req('/sessions/'+sid+'/prompt',{text:'只回复 ROUNDTRIP_OK',idempotencyKey:randomUUID()})).status,202);
 let result;for(let i=0;i<120;i++){result=(await req('/sessions/'+sid)).data;if(!result.isRunning&&result.terminal)break;await delay(1000);}assert.equal(result.terminal,'Completed');assert.ok(JSON.stringify(result.messages).includes('ROUNDTRIP_OK'));
 const x=JSON.parse(docker(['inspect',before.id+'-rt-'+account.id]))[0];assert.equal(x.Image,expectedDigest);assert.equal(x.HostConfig.ReadonlyRootfs,true);assert.ok(x.HostConfig.CapDrop.includes('ALL'));assert.ok(x.HostConfig.SecurityOpt.includes('no-new-privileges'));checks.push({name:label+' real model completes in expected Runtime image',status:'PASS',runtimeDigest:x.Image});
}
try{
 const artifact={...originalManifest,version:originalManifest.version+'-roundtrip-test',runtimeImageDigest:variant('runtime',before.runtimeDigest),parserImageDigest:variant('parser',before.parserDigest)};
 const artifactFile=path.join(state,'roundtrip-test-manifest.json');fs.writeFileSync(artifactFile,JSON.stringify(artifact),{mode:0o600});
 run('update',['--artifact',artifactFile]);
 check('same-schema update propagates distinct Runtime and Parser digests and release metadata',()=>{const m=JSON.parse(fs.readFileSync(path.join(state,'manager.json'))),d=JSON.parse(fs.readFileSync(path.join(state,'deployment.json'))),a=JSON.parse(fs.readFileSync(path.join(state,'candidate-manifest.json')));assert.notEqual(artifact.runtimeImageDigest,before.runtimeDigest);assert.notEqual(artifact.parserImageDigest,before.parserDigest);assert.equal(m.runtimeImageDigest,artifact.runtimeImageDigest);assert.equal(m.runtimeImage,artifact.runtimeImageDigest);assert.equal(m.parserImageDigest,artifact.parserImageDigest);assert.equal(d.runtimeDigest,artifact.runtimeImageDigest);assert.equal(d.parserDigest,artifact.parserImageDigest);assert.equal(d.releaseVersion,artifact.version);assert.deepEqual(a,artifact);});
 await modelProbe(artifact.runtimeImageDigest,'updated');
 run('rollback');
 check('same-schema rollback restores original images Manager configuration and candidate manifest',()=>{assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state,'deployment.json'))),before);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state,'manager.json'))),managerBefore);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state,'candidate-manifest.json'))),originalManifest);const result=JSON.parse(execFileSync(process.execPath,['scripts/ops/install.mjs','health','--state',state],{encoding:'utf8'}));assert.equal(result.healthy,true);});
 await modelProbe(before.runtimeDigest,'rolled back');
}catch(e){checks.push({name:'roundtrip',status:'FAIL',message:e.message});process.exitCode=1;}
finally{fs.writeFileSync(reportFile,JSON.stringify({date:new Date().toISOString(),scope:'real local Compose update and rollback; metadata-only test image variants; real model API and running image digest checked after both transitions',deployment:before.id,checks},null,2)+'\n');console.log(JSON.stringify({checks}));if(checks.every(c=>c.status==='PASS'))for(const tag of tags)try{docker(['image','rm',tag]);}catch{}}
