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
