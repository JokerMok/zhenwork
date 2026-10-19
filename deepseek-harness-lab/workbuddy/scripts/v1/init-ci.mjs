import fs from 'node:fs';import path from 'node:path';import {randomBytes} from 'node:crypto';
if(process.env.CI!=='true')throw Error('This initializer is only for ephemeral CI');
const dir=path.resolve('.state/ci');fs.mkdirSync(dir,{recursive:true,mode:0o700});
const secret=(name,value=randomBytes(32).toString('hex'))=>{const file=path.join(dir,name);fs.writeFileSync(file,value+'\n',{mode:0o600});return file;};
const ownerURL=new URL(process.env.WORKSPACE_TEST_DATABASE_URL);const appURL=new URL(ownerURL);appURL.username='workspace_app';appURL.password=randomBytes(32).toString('hex');secret('app-db-password',appURL.password);
const config={mode:'local',publicOrigin:'http://127.0.0.1:3415',port:3418,host:'127.0.0.1',dataDir:path.join(dir,'data'),databaseURLFile:secret('app-database-url',appURL.href),migrationDatabaseURLFile:secret('migration-database-url',ownerURL.href),authSecretFile:secret('auth-secret'),managerSecretFile:secret('manager-secret'),auditSecretFile:secret('audit-secret'),capabilitySecretFile:secret('capability-secret'),localBridgeEnabled:false};
fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify(config),{mode:0o600});fs.writeFileSync(path.join(dir,'bootstrap.json'),JSON.stringify({email:'ci@local.example',name:'CI Owner',companyName:'CI Test',passwordFile:secret('bootstrap-password')}),{mode:0o600});
console.log(JSON.stringify({ci:'initialized',secretsPrinted:false}));
