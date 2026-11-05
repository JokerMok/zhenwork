import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from 'vitest';
import { prepareEnterpriseProfile } from '../enterprise-core.js';
import { readProfile } from './profile.js';

test('fresh actor-scoped reads preserve preferences, history pagination and pins without starting a worker', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-read-'));
  const actor = { serverId: 'rc2', userId: '7' };
  try {
    const { profile } = await prepareEnterpriseProfile(root, actor);
    execFileSync('python3', [
      '-c',
      `import sqlite3,sys
c=sqlite3.connect(sys.argv[1]);c.executescript("""
CREATE TABLE client_preferences(user_id,key,value);
INSERT INTO client_preferences VALUES('system_default_user','language','"zh-CN"');
INSERT INTO client_preferences VALUES('system_default_user','google.config','enc:v1:secret');
INSERT INTO client_preferences VALUES('other','language','"en-US"');
CREATE TABLE conversations(id,user_id,name,status,updated_at,archived_at);
INSERT INTO conversations VALUES('11111111','system_default_user','Own','finished',123,NULL);
INSERT INTO conversations VALUES('22222222','other','Other','running',124,NULL);
CREATE TABLE messages(id,conversation_id,position,type,content,status,created_at);
INSERT INTO messages VALUES('m1','11111111','right','text','{"content":"own input"}','finish',1);
INSERT INTO messages VALUES('m2','11111111','left','text','{"content":"own reply"}','finish',2);
INSERT INTO messages VALUES('m3','11111111','left','tips','{"content":"internal key","error":{"code":"USER_LLM_PROVIDER_AUTH_FAILED"}}','error',3);
INSERT INTO messages VALUES('m4','22222222','left','text','{"content":"other private reply"}','finish',4);
CREATE TABLE user_order(user_id,scene,item_type,item_id);
INSERT INTO user_order VALUES('system_default_user','pinned','conversation','11111111');
""");c.commit();c.close()`,
      path.join(profile, 'aionui-backend.db'),
    ]);
    expect(await readProfile(root, actor, 'preferences', '[]')).toEqual({ language: 'zh-CN' });
    expect(await readProfile(root, actor, 'conversation', '11111111')).toEqual({ exists: true });
    expect(await readProfile(root, actor, 'conversation', '22222222')).toEqual({ exists: false });
    expect(await readProfile(root, actor, 'conversationView', '11111111')).toEqual({
      id: '11111111',
      name: 'Own',
      messages: [
        { id: 'm1', position: 'right', text: 'own input' },
        { id: 'm2', position: 'left', text: 'own reply' },
      ],
    });
    expect(await readProfile(root, actor, 'conversationView', '22222222')).toBeNull();
    expect(await readProfile(root, actor, 'history')).toMatchObject({
      items: [{ id: '11111111', pinned: 1 }],
      next_cursor: null,
    });
    expect(await readProfile(root, { ...actor, userId: '8' }, 'history')).toEqual({ items: [], next_cursor: null });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a database symlink and never creates a missing database', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-denied-'));
  const actor = { serverId: 'rc2', userId: '7' };
  try {
    expect(await readProfile(root, actor, 'preferences', '[]')).toEqual({});
    const { profile } = await prepareEnterpriseProfile(root, actor);
    await symlink('/etc/passwd', path.join(profile, 'aionui-backend.db'));
    await expect(readProfile(root, actor, 'preferences', '[]')).rejects.toThrow('DENIED');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cold employee reads preserve bounded history, search and schedules without leaking other users or agent config', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'employee-profile-read-'));
  const actor = { serverId: 'rc2', userId: '7' };
  try {
    const { profile } = await prepareEnterpriseProfile(root, actor);
    execFileSync('python3', [
      '-c',
      `import sqlite3,sys
c=sqlite3.connect(sys.argv[1]);c.executescript("""
CREATE TABLE conversations(id,user_id,name,type,status,created_at,updated_at,archived_at,project_id,extra);
INSERT INTO conversations VALUES('11111111','system_default_user','Pinned','aionrs','finished',5,10,NULL,'p1','{"pinned":true,"workspace":"example/project","secret":"redact"}');
INSERT INTO conversations VALUES('22222222','system_default_user','Scheduled','acp','finished',4,10,NULL,NULL,'{"cron_job_id":"job1"}');
INSERT INTO conversations VALUES('33333333','other','Private','aionrs','finished',6,11,NULL,NULL,'{"cron_job_id":"job1"}');
INSERT INTO conversations VALUES('44444444','system_default_user','Archived','aionrs','finished',2,11,19,'p1','{}');
CREATE TABLE projects(user_id,project_id,name,kind);
INSERT INTO projects VALUES('system_default_user','p1','Own project','standard');
CREATE TABLE messages(id,conversation_id,position,type,content,status,created_at,hidden);
INSERT INTO messages VALUES('m1','11111111','right','text','{"content":"matching prompt"}','finish',1,0);
INSERT INTO messages VALUES('m2','11111111','left','text','{"content":"hidden matching text"}','finish',2,1);
INSERT INTO messages VALUES('m3','33333333','left','text','{"content":"matching other user"}','finish',2,0);
CREATE TABLE cron_jobs(id,user_id,name,enabled,schedule_kind,schedule_value,schedule_tz,schedule_description,payload_message,
 execution_mode,agent_config,conversation_id,conversation_title,created_by,description,created_at,updated_at,next_run_at,
 last_run_at,last_status,last_error,run_count,retry_count,max_retries,queue_enabled);
INSERT INTO cron_jobs VALUES('job1','system_default_user','Run report',1,'cron','0 9 * * *','Asia/Shanghai','Morning',
 'Generate report','new_conversation','{"name":"Analyst","assistant_id":"analysis","cli_path":"/private/path","config_options":{"token":"secret"}}',
 '22222222','Own conversation','user','Description',100,200,300,90,'ok','secret error',1,0,3,1);
INSERT INTO cron_jobs SELECT 'job2','other','Private job',enabled,schedule_kind,schedule_value,schedule_tz,schedule_description,payload_message,
 execution_mode,agent_config,'33333333','Private conversation',created_by,description,created_at,updated_at,next_run_at,
 last_run_at,last_status,last_error,run_count,retry_count,max_retries,queue_enabled FROM cron_jobs WHERE id='job1';
""");c.commit();c.close()`,
      path.join(profile, 'aionui-backend.db'),
    ]);

    const args = (params: Record<string, unknown>): string => JSON.stringify(params);
    const first = await readProfile(root, actor, 'conversationPage', args({ limit: 1 }));
    expect(first).toMatchObject({ items: [{ id: '22222222', type: 'acp' }], total: 2, next_cursor: '22222222' });
    const next = await readProfile(root, actor, 'conversationPage', args({ limit: 1, cursor: '22222222' }));
    expect(next).toMatchObject({
      items: [{ id: '11111111', project_id: 'p1', extra: { pinned: true, workspace: 'example/project' } }],
      has_more: false,
    });
    expect(JSON.stringify(next)).not.toContain('redact');
    expect(await readProfile(root, actor, 'archivedConversations', args({ limit: 1 }))).toMatchObject({
      items: [{ id: '44444444', project_name: 'Own project', archived_at: 19 }],
      total: 1,
    });
    expect(await readProfile(root, actor, 'messageSearch', args({ keyword: 'matching', page: 1, limit: 20 }))).toMatchObject({
      total: 1,
      items: [{ message_id: 'm1', preview_text: 'matching prompt' }],
    });
    const schedules = await readProfile(root, actor, 'cronJobs', args({}));
    expect(schedules).toMatchObject([{
      id: 'job1',
      schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Shanghai' },
      metadata: { agent_type: 'acp', agent_config: { name: 'Analyst', assistant_id: 'analysis' } },
      state: { last_status: 'ok', queue_enabled: true },
      target: { payload: { kind: 'message', text: 'Generate report' }, execution_mode: 'new_conversation' },
    }]);
    expect(JSON.stringify(schedules)).not.toMatch(/secret|private\/path|job2/);
    expect(await readProfile(root, actor, 'cronConversations', 'job1')).toMatchObject([{ id: '22222222' }]);
    expect(await readProfile(root, actor, 'cronJobs', args({ id: 'job2' }))).toBeNull();
    expect(await readProfile(root, { ...actor, userId: '8' }, 'cronJobs', args({}))).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
