import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
const root=process.cwd();
const original=fs.readFileSync('packages/desktop/electron.vite.config.ts','utf8');
const temporary='packages/desktop/web.tencent.config.ts';
fs.writeFileSync(temporary,original.replace('export default defineConfig(', 'const desktopConfig = defineConfig(')+'\nexport default async (env) => ({...await desktopConfig(env), main: undefined, preload: undefined});\n');
const run=(args)=>{const r=spawnSync(process.execPath,args,{cwd:root,stdio:'inherit'});if(r.status!==0)throw Error('Web-only build failed');};
try {
 run(['node_modules/electron-vite/bin/electron-vite.js','build','--config',temporary]);
 // Build once locally; the shared Host only streams immutable sidecars. Never
 // spend server CPU recompressing large JS on every authenticated request.
 const assets='out/renderer/assets';
 let plainBytes=0,gzipBytes=0,brotliBytes=0;
 for(const name of fs.readdirSync(assets)) {
   if(!/\.(js|css|svg|json)$/.test(name))continue;
   const file=path.join(assets,name),plain=fs.readFileSync(file);
   if(plain.length<1024)continue;
   const gzip=gzipSync(plain,{level:6});
   const brotli=brotliCompressSync(plain,{params:{[constants.BROTLI_PARAM_QUALITY]:5}});
   if(gzip.length<plain.length)fs.writeFileSync(file+'.gz',gzip);
   if(brotli.length<plain.length)fs.writeFileSync(file+'.br',brotli);
   plainBytes+=plain.length;gzipBytes+=gzip.length;brotliBytes+=brotli.length;
 }
 console.log('Release asset compression',JSON.stringify({plainBytes,gzipBytes,brotliBytes}));
 run(['node_modules/esbuild/bin/esbuild','packages/web-cli/src/enterprise-entry.ts','--bundle','--platform=node','--format=cjs','--target=node22','--alias:@aionui/web-host=./packages/web-host/src/index.ts','--outfile=packages/web-cli/dist/aionui-enterprise-web.cjs']);
} finally {fs.unlinkSync(temporary);}
