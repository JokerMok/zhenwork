import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'../..');
const database=process.argv[2]||'workspace_rc2';if(!['workspace_rc2','workspace_rc2_rehearsal'].includes(database))throw Error('Unrecognized RC2 database');
const sql=q=>execFileSync('docker',['compose','-f',path.join(root,'.state/rc2/compose.json'),'exec','-T','db','psql','-U','workspace_rc2','-d',database,'-v','ON_ERROR_STOP=1','-At'],{input:q,encoding:'utf8',stdio:['pipe','pipe','pipe']});
sql('CREATE TABLE IF NOT EXISTS ai_schema_migrations(version TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW());');
for(const name of fs.readdirSync(path.join(root,'migrations/rc2')).filter(x=>/^\d{4}_[a-z_]+\.sql$/.test(x)).sort()){
 const source=fs.readFileSync(path.join(root,'migrations/rc2',name),'utf8'),hash=createHash('sha256').update(source).digest('hex');
 const existing=sql(`SELECT sha256 FROM ai_schema_migrations WHERE version='${name}';`).trim();
 if(existing){if(existing!==hash)throw Error('Applied migration checksum changed: '+name);console.log(name+' already applied');continue;}
 sql(`BEGIN; SELECT pg_advisory_xact_lock(hashtext('workspace-rc2-schema'));\n${source}\nINSERT INTO ai_schema_migrations(version,sha256) VALUES('${name}','${hash}'); COMMIT;`);console.log(name+' applied');
}
