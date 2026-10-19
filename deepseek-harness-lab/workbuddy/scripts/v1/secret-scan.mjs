import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';
const roots=['apps/','packages/','migrations/','scripts/','tests/v1/','deploy/','docs/v1/','.github/','evidence/v1/','runtime/','README.md','CHANGELOG.md','THIRD_PARTY_NOTICES.md','third-party-lock.json','upstream-harness.lock.json'];
const files=execFileSync('/usr/bin/git',['ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(f=>f&&roots.some(p=>f.startsWith(p)));
const patterns=[/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,/\b(?:sk|AKIA)-[A-Za-z0-9_-]{32,}\b/,/\bBearer\s+[a-f0-9]{48,}\b/i];
const known=[];if(process.env.WORKSPACE_CONFIG_FILE){const config=JSON.parse(fs.readFileSync(process.env.WORKSPACE_CONFIG_FILE));for(const [key,file] of Object.entries(config))if(key.endsWith('SecretFile'))known.push(fs.readFileSync(file,'utf8').trim());}
const findings=[];for(const f of files){if(!fs.statSync(f).isFile()||/\.(png|jpe?g|pdf|zip|gz|woff2?)$/i.test(f))continue;const text=fs.readFileSync(f,'utf8');if(patterns.some(p=>p.test(text))||known.some(s=>s.length>=32&&text.includes(s)))findings.push(f);}
console.log(JSON.stringify({scope:roots,files:files.length,knownLocalSecretCount:known.length,findings,secretValuesPrinted:false}));process.exitCode=findings.length?1:0;
