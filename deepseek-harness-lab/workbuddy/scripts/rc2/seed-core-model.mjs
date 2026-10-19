import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createCipheriv,randomBytes,randomUUID} from 'node:crypto';
import YAML from 'yaml';
const root=path.resolve(import.meta.dirname,'../..'),state=path.join(root,'.state/rc2');
const sql=q=>execFileSync('docker',['compose','-f',path.join(state,'compose.json'),'exec','-T','db','psql','-U','workspace_rc2','-d','workspace_rc2','-v','ON_ERROR_STOP=1','-At'],{input:q,encoding:'utf8',stdio:['pipe','pipe','pipe']});
const exists=sql("SELECT id FROM ai_model WHERE code='doubao-seed-2-0-mini-260428';").trim();
if(exists){console.log(JSON.stringify({status:'ALREADY_SEEDED',modelId:exists}));process.exit(0);}
const container=JSON.parse(execFileSync('docker',['inspect','wb-rc-local-gateway'],{encoding:'utf8'}))[0];
const mount=container.Mounts.find(x=>x.Destination==='/run/secrets/provider');if(!mount)throw Error('Existing provider secret mount missing');
const secret=YAML.parse(fs.readFileSync(mount.Source,'utf8'))?.refs?.VOLCENGINE_ARK_API_KEY;if(typeof secret!=='string'||secret.length<20)throw Error('Existing provider secret unavailable');
// Construct an authenticated envelope compatible with WorkspaceSecrets; do not write plaintext to disk.
const iv=randomBytes(12),aes=createCipheriv('aes-256-gcm',fs.readFileSync(path.join(state,'secret-key')),iv);aes.setAAD(Buffer.from('workspace-provider-v1'));const encrypted=Buffer.concat([aes.update(secret,'utf8'),aes.final(),aes.getAuthTag()]);
const envelope='v1.'+iv.toString('base64')+'.'+encrypted.toString('base64'),provider=randomUUID(),model=randomUUID();
const grantSql=sql("SELECT to_regclass('public.ai_model_policy');").trim()?`INSERT INTO ai_model_policy(id,model_id,subject_type,subject_id,created_by) SELECT gen_random_uuid(),'${model}','USER',user_id,user_id FROM sys_user WHERE user_name IN('rc2-admin','rc2-employee-a','rc2-employee-b');`:`INSERT INTO ai_model_grant(model_id,user_id) SELECT '${model}',user_id FROM sys_user WHERE user_name IN('rc2-admin','rc2-employee-a','rc2-employee-b');`;
sql(`BEGIN; INSERT INTO ai_provider(id,name,provider_type,base_url,secret_cipher) VALUES('${provider}','Ark RC2 Core','ARK','https://ark.cn-beijing.volces.com/api/v3','${envelope}'); INSERT INTO ai_model(id,provider_id,code,name) VALUES('${model}','${provider}','doubao-seed-2-0-mini-260428','Doubao Seed 2.0 Mini'); ${grantSql} COMMIT;`);
console.log(JSON.stringify({status:'SEEDED',providerId:provider,modelId:model,secretStorage:'AES-256-GCM; existing authorized local provider credential; no plaintext output',scope:'R4 initial model only; not R6 dynamic management acceptance'}));
