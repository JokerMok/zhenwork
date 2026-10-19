export class ApiError extends Error {constructor(public code:string,public status:number,message:string){super(message)}}
export async function api<T=unknown>(path:string,body?:unknown,method=body===undefined?'GET':'POST'):Promise<T>{
 const res=await fetch('/api'+path,{method,headers:body===undefined?{}:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 const value=await res.json();if(!res.ok)throw new ApiError(value.error?.code||'InternalError',res.status,value.error?.message||'请求失败');return value;
}
export type Principal={id:string;name:string;email:string;permissions:string[];roleCodes:string[];mustChangePassword:boolean};
export type Brand={productName:string;companyName:string;logo:string|null;logoDark:string|null;favicon:string|null;primaryColor:string;loginTitle:string;loginSubtitle:string;supportText:string;copyright:string};
