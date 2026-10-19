import fs from 'node:fs';import path from 'node:path';import {spawnSync,execFileSync} from 'node:child_process';
export const postgresIndex='sha256:f02121de6f74d30d8a94cd1d9584125e2178d7e6c377d8130112d4e52d867995';
export const postgresManifests={arm64:'sha256:0b2882c46a2b8d8e148431b333394348cf4d7f15aec6df7f17d51dc641e56cfa',amd64:'sha256:aa90e97ee862e558111d34cfb8b2c4bec768c2b039fb791341686928560263b3'};
export function pinPostgres(arch,evidence){
 if(!postgresManifests[arch])throw Error('Unsupported PostgreSQL architecture');
 const platform='linux/'+arch,source='postgres:17-alpine@'+postgresManifests[arch],tag='postgres:17-alpine-'+arch,log=path.join(evidence,'postgres-'+arch+'-pull.log'),fd=fs.openSync(log,'w');
 const r=spawnSync('docker',['pull','--platform',platform,source],{stdio:['ignore',fd,fd]});fs.closeSync(fd);
 const row={name:'postgres',platform,tag,sourceIndex:postgresIndex,sourceReference:source,status:r.status===0?'PASS':'FAIL'};
 if(r.status===0){execFileSync('docker',['tag',source,tag]);const image=JSON.parse(execFileSync('docker',['image','inspect',tag],{encoding:'utf8'}))[0];row.imageDigest=image.Id;row.architecture=image.Architecture;row.descriptorType=image.Descriptor?.mediaType||null;if(image.Architecture!==arch||!image.Config.Env?.includes('PG_MAJOR=17'))row.status='FAIL';}
 return row;
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(import.meta.filename)){
 const arch=process.argv[2],evidence=path.resolve('evidence/v1/p8'),row=pinPostgres(arch,evidence),file=path.join(evidence,'images-'+arch+'.json'),report=JSON.parse(fs.readFileSync(file));report.rows=report.rows.filter(r=>r.name!=='postgres');report.rows.push(row);report.date=new Date().toISOString();fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(row));if(row.status!=='PASS')process.exitCode=1;
}
