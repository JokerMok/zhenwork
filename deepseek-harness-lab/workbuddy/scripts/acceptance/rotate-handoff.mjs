import {randomBytes} from 'node:crypto';import {fs,path,state,load,privateSave,save,login,req,ok,assert,sql,literal} from './context.mjs';
const users=load('users');if(users.handoffReady)throw Error('Handoff credentials already rotated; do not rotate a user-owned acceptance session again');
const admin=(await login(users.admin)).cookie;
for(const role of ['a','b','admin']){
 const password=randomBytes(24).toString('base64url');ok(await req('/admin/users/'+users[role].id+'/reset-password',{password},admin));users[role].password=password;privateSave('users',users);if(role==='admin')fs.writeFileSync(path.join(state,'bootstrap-password'),password+'\n',{mode:0o600});
 const signed=await login(users[role]);const me=ok(await req('/me',undefined,signed.cookie)).data;assert.equal(me.mustChangePassword,true);ok(await req('/auth/sign-out',{},signed.cookie));
}
users.handoffReady=true;users.rotatedAt=new Date().toISOString();privateSave('users',users);privateSave('test-users',{a:users.a,b:users.b});
const rows=sql('SELECT id,enabled,must_change_password FROM users WHERE id IN('+['admin','a','b'].map(k=>literal(users[k].id)).join(',')+')');assert.equal(rows.length,3);assert.ok(rows.every(r=>r.enabled&&r.must_change_password));assert.equal(fs.statSync(path.join(state,'users.json')).mode&0o777,0o600);
save('handoff-accounts',{status:'PASS',accounts:['admin','a','b'].map(k=>({role:k,email:users[k].email,id:users[k].id,enabled:true,mustChangePassword:true})),passwordsPrinted:false,privateMode:'0600',automatedPasswordsRotated:true});console.log(JSON.stringify({status:'PASS',accounts:3,forceChangeAtFirstLogin:true,passwordsPrinted:false}));
