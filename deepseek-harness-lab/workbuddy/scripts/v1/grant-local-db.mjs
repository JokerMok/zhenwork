/** Configure the local application role after migrations. Owner secret never enters the API service. */
import fs from 'node:fs';import path from 'node:path';import pg from 'pg';
const config=JSON.parse(fs.readFileSync(process.env.WORKSPACE_CONFIG_FILE,'utf8'));
const pool=new pg.Pool({connectionString:fs.readFileSync(config.migrationDatabaseURLFile,'utf8').trim()});
const password=fs.readFileSync(path.join(path.dirname(config.databaseURLFile),'app-db-password'),'utf8').trim();
if(!/^[a-f0-9]{64}$/.test(password))throw Error('Unexpected generated password format');
try{
 const found=await pool.query("SELECT 1 FROM pg_roles WHERE rolname='workspace_app'");
 if(!found.rowCount)await pool.query(`CREATE ROLE workspace_app LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
 await pool.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC;
 GRANT CONNECT ON DATABASE workspace TO workspace_app;
 GRANT USAGE ON SCHEMA public TO workspace_app;
 GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO workspace_app;
 REVOKE ALL ON schema_migrations FROM workspace_app;
 GRANT SELECT ON schema_migrations TO workspace_app;
 REVOKE UPDATE,DELETE,TRUNCATE ON audit_events FROM workspace_app;
 REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM workspace_app;`);
 console.log(JSON.stringify({applicationRole:'workspace_app',superuser:false,migrationWrite:false,auditRewrite:false,secretsPrinted:false}));
}finally{await pool.end();}
