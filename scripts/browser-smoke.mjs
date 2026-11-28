// Real browser startup smoke uses a blank page and a dedicated temporary profile.
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import {access} from 'node:fs/promises';
import {availableBrowsers,launchIsolatedBrowser} from '../browser-login.mjs';
import {browserSignIn} from '../magpie/login.mjs';
const browsers=await availableBrowsers(process.platform,homedir(),{...process.env,DISPLAY:process.env.DISPLAY||':99'});
if(!browsers.length)throw Error('CI runner 未找到 Chrome / Edge。');
const cases=browsers.map(browser=>({browser,handoff:false}));
if(process.platform==='win32')cases.push({browser:browsers[0],handoff:true});
for(const {browser,handoff} of cases){
 const root=await mkdtemp(join(tmpdir(),'dw-protocol-smoke-')),abort=new AbortController();
 const started=Date.now();let metadata,profile,browserChild,browserExit,launcherCode;
 try{
  await assert.rejects(browserSignIn(()=>assert.fail('A blank page must not sign in.'),{signal:abort.signal,
   browserOptions:{pollMs:20,diagnosticFile:join(root,'browser-startup-error.json'),discover:async()=>[browser],
    async launch(selected,path,options){
     profile=path;
     const handle=await launchIsolatedBrowser(selected,path,{...options,
      spawnProcess(binary,args,spawnOptions){
       const launch=()=>spawn(binary,[...args.slice(0,-1),'--headless=new','about:blank'],{...spawnOptions,windowsHide:true});
       if(!handoff)return launch();
       // Model a launcher that exits before the second process opens the same profile.
       const stub=spawn(process.execPath,['-e','process.exit(0)'],{...spawnOptions,windowsHide:true});
       stub.once('exit',code=>{
        launcherCode=code;
        browserChild=launch();browserExit=once(browserChild,'exit').catch(()=>[]);
       });
       return stub;
      }});
     metadata=handle.metadata();
     if(!metadata.userAgent||!metadata.chromiumVersion)throw Error('浏览器元数据不完整。');
     setTimeout(()=>abort.abort(),100);return handle;
    }}}).then(result=>{throw Error('Browser sign-in returned '+JSON.stringify(result));}),
   error=>error===abort.signal.reason||error.name==='AbortError');
  await assert.rejects(access(profile),error=>error.code==='ENOENT');
  if(handoff){
   assert.equal(launcherCode,0);
   assert.equal((await browserExit)[0],0,'The browser that took over must close normally.');
  }
 }catch(error){
  try{console.error(JSON.stringify({browser:browser.id,diagnostic:JSON.parse(await readFile(join(root,'browser-startup-error.json'),'utf8'))}));}catch{}
  throw error;
 }finally{
  if(browserChild&&browserChild.exitCode===null){browserChild.kill();await browserExit;}
  await rm(root,{recursive:true,force:true});
 }
 console.log(JSON.stringify({platform:process.platform,runtime:process.versions.bun?'Bun '+process.versions.bun:'Node '+process.versions.node,
  browser:browser.id,chromiumVersion:metadata.chromiumVersion,transport:'loopback-websocket',entry:'browserSignIn',
  ...(handoff?{handoff:true,launcherCode}:{}),cancelledAndCleaned:true,elapsedMs:Date.now()-started,passed:true}));
}
