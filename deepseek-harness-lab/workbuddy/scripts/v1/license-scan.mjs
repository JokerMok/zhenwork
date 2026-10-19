import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
const root=path.resolve(import.meta.dirname,'../..');const lock=JSON.parse(fs.readFileSync(path.join(root,'package-lock.json')));const third=JSON.parse(fs.readFileSync(path.join(root,'third-party-lock.json')));
const allowed=new Set(['MIT','ISC','Apache-2.0','BSD-2-Clause','BSD-3-Clause','0BSD','CC0-1.0','CC-BY-4.0','BlueOak-1.0.0','MIT-0','(MIT OR CC0-1.0)','(MIT OR Apache-2.0)','(MIT AND Zlib)','Python-2.0','MPL-2.0']);
const failure=[],records=[],conditional=[];
for(const [location,p] of Object.entries(lock.packages)){
 if(!location.includes('node_modules/')||p.link)continue;
 const name=location.split('node_modules/').at(-1);let pkg={};try{pkg=JSON.parse(fs.readFileSync(path.join(root,location,'package.json')));}catch{}
 const reviewed=third.reviewedPackageLicenses?.[name+'@'+p.version];let verifiedLicense;
 if(reviewed){const file=path.join(root,reviewed.licenseFile);if(fs.existsSync(file)&&createHash('sha256').update(fs.readFileSync(file)).digest('hex')===reviewed.sha256)verifiedLicense=reviewed.license;else failure.push({location,reason:'reviewed license source changed or missing'});}
 const license=p.license||pkg.license||verifiedLicense||'UNKNOWN';
 if(['LGPL-3.0-or-later','Apache-2.0 AND LGPL-3.0-or-later','Apache-2.0 AND LGPL-3.0-or-later AND MIT'].includes(license)&&name.startsWith('@img/sharp-'))conditional.push(name);else if(!allowed.has(license))failure.push({location,license});
 records.push({project:name,repository:pkg.repository?.url||pkg.repository||null,commit:pkg.gitHead||null,tag:p.version,license,usage:'package dependency',modules:[location],modifications:[],integrity:p.integrity||null,resolved:p.resolved||null,dev:!!p.dev,optional:!!p.optional});
}
for(const project of third.projects)for(const mod of project.modules||[]){
 if(typeof mod!=='object'||!mod.destination)continue;
 const file=path.join(root,mod.destination);if(!fs.existsSync(file))failure.push({file:mod.destination,reason:'missing source'});else if(createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==mod.finalSha256)failure.push({file:mod.destination,reason:'source changed without attribution update'});
 if(/(^|\/)(ee|enterprise)(\/|$)/i.test(mod.upstreamFile))failure.push({file:mod.upstreamFile,reason:'restricted path'});
}
if(process.argv.includes('--update')){third.packageClosures.root=records;third.stage='P5';third.updatedAt=new Date().toISOString().slice(0,10);fs.writeFileSync(path.join(root,'third-party-lock.json'),JSON.stringify(third,null,2)+'\n');}
else {const saved=third.packageClosures.root||[];if(saved.length!==records.length||records.some(r=>!saved.some(s=>s.modules[0]===r.modules[0]&&s.tag===r.tag&&s.integrity===r.integrity&&s.license===r.license)))failure.push({reason:'root package closure needs reviewed update'});}
console.log(JSON.stringify({scope:'root npm lock and registered source ports',packages:records.length,conditionalLGPL:conditional,failures:failure,binaryDistributionGate:'P8 matching source and replacement notices required'},null,2));process.exitCode=failure.length?1:0;
