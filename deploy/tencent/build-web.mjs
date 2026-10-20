import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root=process.cwd();
const original=fs.readFileSync('packages/desktop/electron.vite.config.ts','utf8');
const temporary='packages/desktop/web.tencent.config.ts';
fs.writeFileSync(temporary,original.replace('export default defineConfig(', 'const desktopConfig = defineConfig(')+'\nexport default async (env) => ({...await desktopConfig(env), main: undefined, preload: undefined});\n');
const run=(args)=>{const r=spawnSync(process.execPath,args,{cwd:root,stdio:'inherit'});if(r.status!==0)throw Error('Web-only build failed');};
try {
 run(['node_modules/electron-vite/bin/electron-vite.js','build','--config',temporary]);
 run(['node_modules/esbuild/bin/esbuild','packages/web-cli/src/enterprise-entry.ts','--bundle','--platform=node','--format=cjs','--target=node22','--alias:@aionui/web-host=./packages/web-host/src/index.ts','--outfile=packages/web-cli/dist/aionui-enterprise-web.cjs']);
} finally {fs.unlinkSync(temporary);}
