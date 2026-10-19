import fs from 'node:fs';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
await import('/opt/harness/apps/cli/lib/bin.js');
const resolve=createRequire('/opt/harness/.workbuddy-security/package.json').resolve;
const sharp=(await import(resolve('sharp'))).default;
const png=await sharp({create:{width:2,height:2,channels:4,background:'#124567'}}).png().toBuffer();
assert.equal(process.getuid(),10001);assert.equal(sharp.versions.sharp,'0.35.4');assert.ok(png.length>50);
const exclusions=JSON.parse(fs.readFileSync('/opt/harness/workbuddy-image-exclusions.json'));
console.log(JSON.stringify({status:'PASS',node:process.version,arch:process.arch,uid:process.getuid(),cliImport:'PASS',pngBytes:png.length,sharp:sharp.versions.sharp,vips:sharp.versions.vips,developmentRemoved:exclusions.developmentRemoved.length,excluded:exclusions.rows,overlay:JSON.parse(fs.readFileSync('/opt/harness/workbuddy-security-overlay.json'))}));
