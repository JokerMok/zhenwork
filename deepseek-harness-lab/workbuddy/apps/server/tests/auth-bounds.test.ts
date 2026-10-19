import assert from 'node:assert/strict';
import {test} from 'node:test';
import {boundedHash} from '../src/auth-routes.ts';
test('password work is bounded to four active and twenty-four queued operations',async()=>{
 let active=0,max=0,release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
 const jobs=Array.from({length:28},()=>boundedHash(async()=>{active++;max=Math.max(max,active);await gate;active--;return true;}));
 await assert.rejects(boundedHash(async()=>true),(e:{status?:number})=>e.status===429);assert.equal(active,4);
 release();assert.equal((await Promise.all(jobs)).length,28);assert.equal(max,4);assert.equal(await boundedHash(async()=>42),42);
});
