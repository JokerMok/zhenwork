import fs from 'node:fs';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
const arch=process.argv[2];if(!['arm64','amd64'].includes(arch))throw Error('Choose arm64 or amd64');
const ref='workspace-runtime:p8-'+arch;
const image=JSON.parse(execFileSync('docker',['image','inspect',ref],{encoding:'utf8'}))[0];assert.equal(image.Architecture,arch);
const probe=`const fs=require('fs');const absent=['/usr/bin/infocmp','/usr/lib/systemd/systemd-homed','/lib/systemd/systemd-homed','/usr/share/perl/5.40/Archive/Tar.pm','/usr/share/perl5/Archive/Tar.pm','/usr/local/lib/node_modules/npm'];const special=[];function walk(p){for(const n of fs.readdirSync(p)){const q=p+'/'+n;const s=fs.lstatSync(q);if(s.isSymbolicLink())continue;if(s.isDirectory())walk(q);else if(s.isFile()&&(s.mode&0o6000))special.push(q);}}walk('/usr');console.log(JSON.stringify({uid:process.getuid(),node:process.version,absent:Object.fromEntries(absent.map(p=>[p,!fs.existsSync(p)])),specialPermissionFiles:special,securityStatus:fs.readFileSync('/proc/self/status','utf8').split('\\n').filter(x=>/^(Cap|NoNewPrivs)/.test(x)),fstab:fs.readFileSync('/etc/fstab','utf8').split('\\n').filter(x=>x.trim()&&!x.trim().startsWith('#'))}));`;
const result=JSON.parse(execFileSync('docker',['run','--rm','--platform','linux/'+arch,'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','256m','--cpus','1',image.Id,'node','-e',probe],{encoding:'utf8'}));
assert.equal(result.uid,10001);assert.ok(Object.values(result.absent).every(Boolean));assert.deepEqual(result.specialPermissionFiles,[]);assert.deepEqual(result.fstab,[]);assert.ok(result.securityStatus.filter(x=>x.startsWith('Cap')).every(x=>x.endsWith('0000000000000000')));assert.ok(result.securityStatus.some(x=>/^NoNewPrivs:\s+1$/.test(x)));
const rows=[
 ['CVE-2025-69720','VULNERABLE_CODE_REMOVED','The affected infocmp program is absent. ncurses package metadata remains in raw scans.'],
 ['CVE-2026-16742','AFFECTED_COMPONENT_NOT_INSTALLED','systemd-homed is absent; libsystemd/libudev source-package matches remain visible.'],
 ['CVE-2026-9538','AFFECTED_COMPONENT_NOT_INSTALLED','Perl Archive::Tar module is absent; perl-base remains installed.'],
 ['CVE-2026-54369','MITIGATED_IN_RUNTIME_PROFILE','The library remains vulnerable. No host-privileged caller or host filesystem is exposed under enforced uid/capabilities/no-new-privileges restrictions; this is not a package fix.'],
 ['CVE-2026-76642','MITIGATED_IN_RUNTIME_PROFILE','No privileged mount helper execution: non-root, no capabilities, no privilege elevation, no fstab authorization. Package remains vulnerable.'],
 ['CVE-2026-78408','MITIGATED_IN_RUNTIME_PROFILE','No root operator or host cgroup process access is provided; privileged nsenter use is outside this profile. Package remains vulnerable.'],
 ['CVE-2026-78409','MITIGATED_IN_RUNTIME_PROFILE','No authorized fstab X-mount.subdir entries or privileged mount context. Package remains vulnerable.'],
 ['CVE-2026-78410','MITIGATED_IN_RUNTIME_PROFILE','mount has no setuid bit, no privilege elevation and no authorized fstab source. Package remains vulnerable.']
].map(([id,status,rationale])=>({id,status,rationale,source:'https://security-tracker.debian.org/tracker/'+id}));
const report={date:new Date().toISOString(),ref,imageDigest:image.Id,architecture:arch,status:'IMAGE_POLICY_PASS',vulnerabilityDisposition:'THREE_COMPONENT_EXCLUSIONS_FIVE_PROFILE_MITIGATIONS',scope:'Actual image binary policy probe in the enforced Runtime security profile. Not a claim that Debian packages are patched or safe under privileged/root execution. Actual Manager deployment is checked separately by security regression.',result,rows};
fs.writeFileSync('evidence/v1/p8/runtime-'+arch+'-policy.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
