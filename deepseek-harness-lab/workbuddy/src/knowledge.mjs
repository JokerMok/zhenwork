import fs from 'node:fs';
/** The execution principal is fixed by container provisioning, never caller args. */
export function searchKnowledge(owner,args){
 if(!args||typeof args.query!=='string'||Object.keys(args).some(k=>!['query','docId'].includes(k))||args.query.length>1000)throw Error('INVALID_QUERY');
 const docs=JSON.parse(fs.readFileSync('/knowledge/documents.json','utf8'));
 return docs.filter(d=>d.owner===owner&&d.tenant==='alpha'&&Array.isArray(d.acl)&&d.acl.includes(owner))
 .filter(d=>args.docId===undefined||d.id===args.docId).filter(d=>(d.title+' '+d.text).toLowerCase().includes(args.query.toLowerCase()))
 .slice(0,5).map(d=>({id:d.id,title:d.title,text:d.text,owner:d.owner,tenant:d.tenant}));
}
