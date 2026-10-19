import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';
const dir='.build/source-bundle',reports=['native-source-downloads.json','rsvg-crates.json'];for(const file of reports){const r=JSON.parse(fs.readFileSync('evidence/v1/p8/'+file));if(r.rows.some(x=>x.status!=='PASS'))throw Error('Incomplete source acquisition: '+file);fs.copyFileSync('evidence/v1/p8/'+file,path.join(dir,file));}fs.mkdirSync(path.join(dir,'build'),{recursive:true});for(const file of ['sharp-libvips-build.sh','sharp-libvips-root.sh','versions.properties'])fs.copyFileSync('.research/p8-licenses/'+file,path.join(dir,'build',file));fs.copyFileSync('.research/p8-licenses/librsvg/Cargo.lock',path.join(dir,'build/Cargo.lock'));
fs.copyFileSync('docs/v1/native-library-replacement.md',path.join(dir,'README.md'));fs.mkdirSync('third-party/licenses/native',{recursive:true});fs.copyFileSync(path.join(dir,'native/32-THIRD-PARTY-NOTICES.md'),'third-party/licenses/native/sharp-libvips-NOTICES.md');
execFileSync('python3',['-c',`import pathlib,tarfile,re,json
root=pathlib.Path('.build/source-bundle');out=pathlib.Path('third-party/licenses/native');rows=[]
for file in sorted((root/'native').iterdir()):
 try:
  with tarfile.open(file) as t:
   for member in t.getmembers():
    if member.isfile() and member.size<200000 and re.match(r'^(COPYING|LICENSE|LICENCE|COPYRIGHT|NOTICE|FTL\\.TXT)',pathlib.PurePosixPath(member.name).name,re.I):
     name=file.name+'--'+re.sub(r'[^A-Za-z0-9._-]','_',member.name);data=t.extractfile(member).read();(out/name).write_bytes(data);rows.append({'archive':file.name,'member':member.name,'output':name})
 except tarfile.ReadError: pass
(out/'index.json').write_text(json.dumps(rows,indent=2))
`]);
fs.cpSync('third-party/licenses/native',path.join(dir,'licenses'),{recursive:true});fs.mkdirSync('.build/releases',{recursive:true});const output='.build/releases/native-corresponding-source.tar.gz';execFileSync('tar',['-czf',path.resolve(output),'-C',path.resolve(dir),'.']);const h=createHash('sha256');for await(const b of fs.createReadStream(output))h.update(b);const report={date:new Date().toISOString(),artifact:output,sha256:h.digest('hex'),bytes:fs.statSync(output).size,nativeSourceItems:35,rsvgRegistryCrates:350,scope:'sharp/libvips native closure only; OS and Harness closure handled separately',replacementBuildTest:'NOT_RUN'};fs.writeFileSync('evidence/v1/p8/native-source-bundle.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
