import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {getMigrations} from 'better-auth/db/migration';
import {loadConfig} from '../../apps/server/src/config.ts';
import {createPool} from '../../apps/server/src/db.ts';
import {authOptions} from '../../apps/server/src/auth.ts';
import {verifySchema} from '../../packages/database/src/migrate.ts';
const config=loadConfig(),pool=createPool(config);
after(()=>pool.end());
test('application identity is restricted and verifies schema without DDL',async()=>{
 const {rows}=await pool.query('SELECT current_user,rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user');
 assert.equal(rows[0].current_user,'workspace_app');assert.equal(rows[0].rolsuper,false);assert.equal(rows[0].rolcreatedb,false);assert.equal(rows[0].rolcreaterole,false);
 await verifySchema(pool,'migrations');
 for(const sql of ['CREATE TABLE prohibited_table(id int)','DELETE FROM schema_migrations WHERE FALSE','UPDATE audit_events SET result=\'changed\' WHERE FALSE','DELETE FROM audit_events WHERE FALSE','TRUNCATE audit_events']) await assert.rejects(pool.query(sql),e=>(e as {code:string}).code==='42501');
});
test('Better Auth schema has no missing tables or columns',async()=>{
 const plan=await getMigrations(authOptions(pool,config));assert.deepEqual(plan.toBeCreated,[]);assert.deepEqual(plan.toBeAdded,[]);
});
test('single enterprise constraint and review-only capability defaults',async()=>{
 const {rows}=await pool.query('SELECT COUNT(*) AS count FROM organizations');assert.equal(rows[0].count,'1');
 const setting=await pool.query("SELECT value FROM system_settings WHERE key='local_bridge'");assert.equal(setting.rows[0].value.enabled,false);
 const caps=await pool.query("SELECT code FROM capabilities WHERE code IN ('bash','shell','eval')");assert.equal(caps.rowCount,0);
});
