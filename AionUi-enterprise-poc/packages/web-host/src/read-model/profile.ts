import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { prepareEnterpriseProfile } from '../enterprise-core.js';
import type { EnterpriseActor } from '../enterprise-gateway.js';

const execute = promisify(execFile);
const pending = new Map<string, Promise<unknown>>();
// Read only the worker's existing local identity in its actor-confined profile.
// Never decrypt credentials, migrate a schema, or write to the worker database.
const inspect = `import sqlite3,json,sys,urllib.parse
file,op,argument=sys.argv[1:]
c=sqlite3.connect('file:'+urllib.parse.quote(file,safe='/')+'?mode=ro',uri=True,timeout=1)
c.execute('PRAGMA query_only=ON');c.row_factory=sqlite3.Row
uid='system_default_user'
history_extra_keys=('workspace','custom_workspace','is_temporary_workspace','team_id','teamId','is_health_check','pinned','pinned_at','sortOrder','backend','assistant_id','preset_assistant_id','custom_agent_id','agent_id','agent_name')
def decode_object(raw):
 try:
  value=json.loads(raw)
  return value if isinstance(value,dict) else {}
 except (TypeError,ValueError):return {}
def history_row(row):
 r=dict(row)
 extra={key:value for key,value in decode_object(r.get('extra')).items() if key in history_extra_keys}
 workspace=extra.get('workspace')
 if isinstance(workspace,str) and '-temp-' in workspace.replace(chr(92),'/').rstrip('/').split('/')[-1]:
  extra['is_temporary_workspace']=True
 if extra.get('is_temporary_workspace') is True:extra['custom_workspace']=False
 return dict(id=r['id'],name=r['name'],type=r.get('type') or 'aionrs',
  created_at=r.get('created_at') or r['updated_at'],modified_at=r['updated_at'],
  project_id=r.get('project_id'),status=r['status'] if r['status']!='running' else 'pending',
  pinned=bool(extra.get('pinned')),extra=extra)
if op=='preferences':
 result={}
 keys=set(json.loads(argument))
 for r in c.execute('SELECT key,value FROM client_preferences WHERE user_id=?',(uid,)):
  if (keys and r['key'] not in keys) or r['value'].startswith('enc:v1:') or r['key'] in {'tools.speechToText','speechToText','tools.imageGenerationModel','mcp.config','google.config'}:continue
  try:result[r['key']]=json.loads(r['value'])
  except ValueError:result[r['key']]=r['value']
elif op=='settings':
 row=c.execute('SELECT * FROM system_settings WHERE user_id=?',(uid,)).fetchone()
 result={'language':'en-US','notification_enabled':True,'cron_notification_enabled':False,'command_queue_enabled':False,'save_upload_to_workspace':False,'cross_session_message_enabled':True}
 if row:
  for k in result:
   if k in row.keys():result[k]=row[k] if k=='language' else bool(row[k])
elif op=='conversation':
 row=c.execute('SELECT id FROM conversations WHERE id=? AND user_id=? AND archived_at IS NULL',(argument,uid)).fetchone()
 result={'exists':row is not None}
elif op=='conversationView':
 page=decode_object(argument) if argument.startswith('{') else {'id':argument}
 conversation=page.get('id','')
 row=c.execute('SELECT id,name FROM conversations WHERE id=? AND user_id=? AND archived_at IS NULL',(conversation,uid)).fetchone()
 result=None
 if row:
  result=dict(row)
  before=page.get('before','')
  target=page.get('target','')
  args=[conversation]
  where="conversation_id=? AND type='text'"
  if 'hidden' in {column[1] for column in c.execute('PRAGMA table_info(messages)')}:
   where+=' AND hidden=0'
  if before or target:
   anchor=c.execute('SELECT id,created_at FROM messages WHERE conversation_id=? AND id=?',(conversation,before or target)).fetchone()
   if anchor:
    where+=' AND (created_at<? OR (created_at=? AND id'+('<' if before else '<=')+'?))'
    args.extend([anchor['created_at'],anchor['created_at'],anchor['id']])
   elif before:where+=' AND 0'
  messages=c.execute("SELECT id,position,content FROM messages WHERE "+where+" ORDER BY created_at DESC,id DESC LIMIT 41",args).fetchall()
  result['messages']=[]
  for m in reversed(messages[:40]):
   text=decode_object(m['content']).get('content')
   if isinstance(text,str):result['messages'].append({'id':m['id'],'position':m['position'],'text':text[:16000]})
  if page.get('paging'):result['nextOlder']=messages[39]['id'] if len(messages)>40 else None
elif op in ('conversationPage','archivedConversations'):
 params=json.loads(argument)
 cursor=params.get('cursor','')
 limit=params.get('limit',100)
 archived=op=='archivedConversations'
 where='c.user_id=? AND c.archived_at IS '+('NOT NULL' if archived else 'NULL')
 if archived:
  where+=" AND NOT (CASE WHEN json_valid(c.extra) THEN coalesce(json_extract(c.extra,'$.team_id'),json_extract(c.extra,'$.teamId'),'') ELSE '' END != '')"
 args=[uid]
 total=c.execute('SELECT COUNT(*) FROM conversations c WHERE '+where,args).fetchone()[0]
 if cursor:
  row=c.execute('SELECT updated_at FROM conversations WHERE id=? AND user_id=?',(cursor,uid)).fetchone()
  if row:where+=' AND (c.updated_at<? OR (c.updated_at=? AND c.id<?))';args.extend([row[0],row[0],cursor])
  else:where+=' AND 0'
 rows=c.execute("SELECT c.* FROM conversations c WHERE "+where+" ORDER BY c.updated_at DESC,c.id DESC LIMIT ?",args+[limit+1]).fetchall()
 items=[history_row(row) for row in rows[:limit]]
 if archived:
  for item,row in zip(items,rows):
   project=None
   if item['project_id']:
    project=c.execute("SELECT name FROM projects WHERE user_id=? AND kind='standard' AND project_id=?",(uid,item['project_id'])).fetchone()
   item.update(archived_at=row['archived_at'],project_name=project['name'] if project else None)
 result=dict(items=items,total=total,has_more=len(rows)>limit,next_cursor=items[-1]['id'] if len(rows)>limit else None)
elif op=='messageSearch':
 params=json.loads(argument)
 limit=params['limit']
 offset=(params['page']-1)*limit
 text="CASE WHEN json_valid(m.content) THEN coalesce(json_extract(m.content,'$.content'),json_extract(m.content,'$.text'),'') ELSE '' END"
 scope=" FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.user_id=? AND c.archived_at IS NULL AND m.type='text' AND coalesce(m.hidden,0)=0 AND instr(lower("+text+"),lower(?))>0"
 args=[uid,params['keyword']]
 total=c.execute("SELECT COUNT(*)"+scope,args).fetchone()[0]
 rows=c.execute("SELECT c.*, m.id AS message_id,m.created_at AS message_created_at,substr("+text+",1,500) AS preview_text"+scope+" ORDER BY m.created_at DESC,m.id DESC LIMIT ? OFFSET ?",args+[limit+1,offset]).fetchall()
 result=dict(items=[dict(message_id=row['message_id'],message_type='text',message_created_at=row['message_created_at'],
  preview_text=row['preview_text'],conversation=history_row(row)) for row in rows[:limit]],total=total,has_more=len(rows)>limit)
elif op=='cronConversations':
 rows=c.execute("""SELECT c.* FROM conversations c WHERE c.user_id=? AND c.archived_at IS NULL
  AND EXISTS(SELECT 1 FROM cron_jobs j WHERE j.id=? AND j.user_id=c.user_id)
  AND CASE WHEN json_valid(c.extra) THEN (json_extract(c.extra,'$.cronJobId')=? OR json_extract(c.extra,'$.cron_job_id')=?) ELSE 0 END
  ORDER BY c.updated_at DESC,c.id DESC LIMIT 501""",(uid,argument,argument,argument)).fetchall()
 if len(rows)>500:raise ValueError('scheduled conversation read limit')
 result=[history_row(row) for row in rows]
elif op=='cronJobs':
 params=decode_object(argument)
 sql="SELECT j.*,c.type AS conversation_type FROM cron_jobs j LEFT JOIN conversations c ON c.id=j.conversation_id AND c.user_id=j.user_id WHERE j.user_id=?"
 args=[uid]
 if params.get('id'):
  sql+=' AND j.id=?';args.append(params['id'])
 if params.get('conversation'):
  sql+=' AND j.conversation_id=?';args.append(params['conversation'])
 rows=c.execute(sql+" ORDER BY j.created_at ASC,j.id ASC LIMIT 501",args).fetchall()
 if len(rows)>500:raise ValueError('scheduled task read limit')
 result=[]
 for row in rows:
  job=dict(row)
  kind=job['schedule_kind']
  schedule=dict(kind=kind,description=job['schedule_description'] or '')
  if kind=='cron':
   schedule.update(expr=job['schedule_value'],tz=job['schedule_tz'])
  else:
   schedule['at_ms' if kind=='at' else 'every_ms']=int(job['schedule_value'])
  config=decode_object(job['agent_config'])
  config={key:config[key] for key in ('name','assistant_id','custom_agent_id') if isinstance(config.get(key),str)}
  metadata={key:job[key] for key in ('conversation_id','conversation_title','created_by','created_at','updated_at')}
  metadata.update(agent_type=job['conversation_type'] or job.get('agent_type') or '')
  if config:metadata['agent_config']=config
  state={key:job[key] for key in ('run_count','retry_count','max_retries','last_status')}
  state.update(next_run_at_ms=job['next_run_at'],last_run_at_ms=job['last_run_at'],queue_enabled=bool(job.get('queue_enabled')))
  result.append(dict(id=job['id'],name=job['name'],description=job['description'],enabled=bool(job['enabled']),
   schedule=schedule,metadata=metadata,state=state,target=dict(execution_mode=job['execution_mode'],
   payload=dict(kind='message',text=job['payload_message']))))
 if params.get('id'):result=result[0] if result else None
elif op=='history':
 cursor=argument
 args=[uid];where='c.user_id=? AND c.archived_at IS NULL'
 if cursor:
  row=c.execute('SELECT updated_at FROM conversations WHERE id=? AND user_id=?',(cursor,uid)).fetchone()
  if row:where+=' AND (c.updated_at<? OR (c.updated_at=? AND c.id<?))';args.extend([row[0],row[0],cursor])
  else:where+=' AND 0'
 rows=c.execute("SELECT c.id,c.name,c.status,c.updated_at,EXISTS(SELECT 1 FROM user_order p WHERE p.user_id=c.user_id AND p.scene='pinned' AND p.item_type='conversation' AND p.item_id=c.id) AS pinned FROM conversations c WHERE "+where+" ORDER BY c.updated_at DESC,c.id DESC LIMIT 101",args).fetchall()
 result={'items':[dict(r) for r in rows[:100]],'next_cursor':rows[99]['id'] if len(rows)>100 else None}
else:raise ValueError('unsupported read model')
print(json.dumps(result,ensure_ascii=False))
c.close()
`;

/** Fresh bounded reads; only identical concurrent reads share work, never stored authorization. */
export async function readProfile(
  root: string,
  actor: EnterpriseActor,
  operation:
    | 'preferences'
    | 'settings'
    | 'history'
    | 'conversation'
    | 'conversationView'
    | 'conversationPage'
    | 'archivedConversations'
    | 'messageSearch'
    | 'cronJobs'
    | 'cronConversations',
  argument = ''
): Promise<unknown> {
  const { profile } = await prepareEnterpriseProfile(root, actor);
  const filename = path.join(await realpath(profile), 'aionui-backend.db');
  const entry = await lstat(filename).catch((error: NodeJS.ErrnoException): null => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!entry) {
    if (operation === 'history') return { items: [], next_cursor: null };
    if (operation === 'conversationView') return null;
    if (operation === 'conversationPage' || operation === 'archivedConversations')
      return { items: [], total: 0, has_more: false, next_cursor: null };
    if (operation === 'messageSearch') return { items: [], total: 0, has_more: false };
    if (operation === 'cronConversations') return [];
    if (operation === 'cronJobs') return (JSON.parse(argument || '{}') as { id?: string }).id ? null : [];
    return {};
  }
  if (entry.isSymbolicLink() || !entry.isFile() || (await realpath(filename)) !== filename) {
    throw new Error('PROFILE_DATABASE_DENIED');
  }
  for (const candidate of [filename, filename + '-wal', filename + '-shm']) {
    const sidecar = await lstat(candidate).catch((error: NodeJS.ErrnoException): null => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (sidecar && (sidecar.isSymbolicLink() || !sidecar.isFile() || sidecar.nlink !== 1)) {
      throw new Error('PROFILE_DATABASE_DENIED');
    }
  }
  const key = JSON.stringify([filename, operation, argument]);
  const existing = pending.get(key);
  if (existing) return existing;
  const result = execute('python3', ['-c', inspect, filename, operation, argument], {
    timeout: 5000,
    maxBuffer: 2 * 1024 * 1024,
  }).then(({ stdout }) => JSON.parse(stdout) as unknown);
  pending.set(key, result);
  try {
    return await result;
  } finally {
    if (pending.get(key) === result) pending.delete(key);
  }
}
