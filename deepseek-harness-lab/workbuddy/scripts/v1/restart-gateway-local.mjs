import fs from 'node:fs';import {execFileSync} from 'node:child_process';
const inspect=JSON.parse(execFileSync('docker',['inspect','wb-v1-gateway'],{encoding:'utf8'}))[0];if(inspect.Config.Labels?.['workspace.product']!=='v1-gateway')throw Error('Foreign gateway');
const networks=Object.keys(inspect.NetworkSettings.Networks).filter(n=>n!=='bridge');for(const name of networks){const n=JSON.parse(execFileSync('docker',['network','inspect',name],{encoding:'utf8'}))[0];if(n.Labels?.['workspace.product']!=='v1')throw Error('Foreign network');}
execFileSync('docker',['rm','-f','wb-v1-gateway'],{stdio:'pipe'});execFileSync(process.execPath,['scripts/v1/init-runtime-local.mjs'],{stdio:'pipe'});for(const name of networks)execFileSync('docker',['network','connect','--alias','model-gateway',name,'wb-v1-gateway'],{stdio:'pipe'});
console.log(JSON.stringify({gateway:'restarted',networks:networks.length,providerCredentialReadByLauncher:false}));
