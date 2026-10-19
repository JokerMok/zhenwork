/** Parse valid JSON and reject ambiguous duplicate object keys, including escaped spellings. */
export function strictJson(text:string):unknown {
 const value:unknown=JSON.parse(text),stack:(Set<string>|null)[]=[];
 let previous='';
 for(const match of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\]:]/g)){
  const token=match[0];
  if(token==='{')stack.push(new Set());
  else if(token==='[')stack.push(null);
  else if(token==='}'||token===']')stack.pop();
  else if(token===':'){
   const keys=stack.at(-1),key:string=JSON.parse(previous);
   if(!keys||keys.has(key))throw Error('DuplicateJsonKey');
   keys.add(key);
  }
  previous=token;
 }
 return value;
}
