/** Local-only, creates namespaced containers/secrets. Never resets existing accounts or volumes. */
import fs from 'node:fs';import path from 'node:path';import {randomBytes} from 'node:crypto';import {execFileSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'../..'),dir=path.join(root,'.state/v1');fs.mkdirSync(dir,{recursive:true,mode:0o700});
const configFile=path.join(dir,'config.json');
if(fs.existsSync(configFile)){console.log(JSON.stringify({local:'already_initialized',configFile,secretsPrinted:false}));process.exit(0);}
const secret=(name,value=randomBytes(32).toString('hex'))=>{const file=path.join(dir,name);fs.writeFileSync(file,value+'\n',{mode:0o600});return file;};
const password=randomBytes(32).toString('hex');const dbEnv=secret('postgres.env',`POSTGRES_USER=workspace_migrator\nPOSTGRES_DB=workspace\nPOSTGRES_PASSWORD=${password}`);
execFileSync('docker',['run','-d','--name','wb-v1-postgres','--label','workbuddy.stage=production-local','--env-file',dbEnv,'-p','127.0.0.1::5432','-v','wb-v1-pg:/var/lib/postgresql/data','--memory','768m','--pids-limit','128','postgres:17-alpine'],{stdio:'pipe'});
const port=execFileSync('docker',['port','wb-v1-postgres','5432/tcp'],{encoding:'utf8'}).trim().split(':').at(-1);
const ownerURL=`postgresql://workspace_migrator:${password}@127.0.0.1:${port}/workspace`;
const appPassword=randomBytes(32).toString('hex');const appPasswordFile=secret('app-db-password',appPassword);
const config={mode:'local',publicOrigin:'http://127.0.0.1:3415',port:3418,host:'127.0.0.1',dataDir:path.join(dir,'data'),databaseURLFile:secret('app-database-url',`postgresql://workspace_app:${appPassword}@127.0.0.1:${port}/workspace`),migrationDatabaseURLFile:secret('migration-database-url',ownerURL),authSecretFile:secret('auth-secret'),managerSecretFile:secret('manager-secret'),auditSecretFile:secret('audit-secret'),capabilitySecretFile:secret('capability-secret'),managerURL:'http://127.0.0.1:3419',uploadLimitBytes:20*1024*1024,maxActiveRuntimes:20,runtimeImage:'workspace-runtime:local',runtimeMemoryMb:768,localBridgeEnabled:false};
fs.mkdirSync(config.dataDir,{recursive:true,mode:0o700});fs.writeFileSync(configFile,JSON.stringify(config,null,2),{mode:0o600});
fs.writeFileSync(path.join(dir,'bootstrap.json'),JSON.stringify({email:'owner@local.example',name:'本地管理员',companyName:'企业验证环境',passwordFile:secret('bootstrap-password')}),{mode:0o600});
console.log(JSON.stringify({local:'created',configFile,bootstrapFile:path.join(dir,'bootstrap.json'),database:'PostgreSQL 17',secretsPrinted:false}));
